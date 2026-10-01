import { loadConfig } from './config/index.js';
import { BotDatabase } from './db/database.js';

import { createVK } from './vk/client.js';
import { VKSender } from './vk/sender.js';

import { Logger } from './logger/logger.js';

import { TemplateManager } from './templates/manager.js';
import { CommandHandler } from './commands/handler.js';

import {
  buildEnricherForSource,
  buildRegistries,
  validateSources
} from './registries.js';
import { SourcePipeline } from './pipeline/source-pipeline.js';
import { Scheduler } from './pipeline/scheduler.js';
import { compileFilter } from './core/filter.js';
import { toMessage } from './utils/to-message.js';
import type { AiSource } from './registries.js';
import type { SourcePipeline as Pipeline } from './pipeline/source-pipeline.js';

/**
 * Старт бота: конфигурация -> хранилище -> VK -> пайплайны -> команды.
 *
 * Каждый шаг проверяет себя сам и падает с полным списком проблем, а не с
 * первой найденной: бот перезапускается под pm2, и падение на первом поле
 * означало бы серию рестартов с одним и тем же сообщением.
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  const registries = buildRegistries(config);

  /*
   * Стратегии проверяются ДО сборки пайплайнов. Опечатка в `site` или
   * `enrich: openrouter` без ключа должна дать один понятный список проблем,
   * а не падение где-то в середине цикла.
   */
  validateSources(registries, config.sources, config.openRouter !== null);

  // Каталог под базу создаёт сам BotDatabase — mkdir в двух местах означал бы
  // два места, где путь к базе может разойтись.
  const db = new BotDatabase(config.databasePath);
  db.addAdmin(config.ownerId, 'owner');

  const vk = createVK(config.vkToken);

  const sender = new VKSender({
    vk,
    userAgent: config.userAgent,
    imageDownloadTimeoutMs: config.imageDownloadTimeoutMs,
    uploadTimeoutMs: config.vkUploadTimeoutMs
  });

  const logger = new Logger(sender, config.adminChat, config.logLevel);
  const templates = new TemplateManager();
  const scheduler = new Scheduler(logger);

  const pipelines = new Map<string, Pipeline>();
  const aiSources: AiSource[] = [];

  /*
   * Каждый источник — пайплайн из трёх независимых кусков: адаптера (как
   * читаем), стратегии сайта (что делаем с записью) и обогатителя (как пишем
   * текст). Всё приходит из `config/sources.yml`, поэтому цикл ниже не меняется
   * вместе с количеством источников.
   */
  for (const sourceConfig of config.sources) {
    templates.register(sourceConfig.id, sourceConfig.template);

    const { enricher, ai } = await buildEnricherForSource(config, sourceConfig);

    if (ai) {
      aiSources.push(ai);
    }

    pipelines.set(
      sourceConfig.id,
      new SourcePipeline({
        sourceId: sourceConfig.id,
        sourceName: sourceConfig.name,
        adapter: registries.sourceAdapters.create(sourceConfig),
        enricher,
        db,
        templates,
        sender,
        logger,
        targetChat: config.targetChat,
        textMode: sourceConfig.textMode,
        textLimit: sourceConfig.textLimit,
        // Фильтр компилируется один раз на источник, а не на каждый заголовок.
        generateWhen: sourceConfig.generateWhen
          ? compileFilter(
              sourceConfig.generateWhen,
              `${sourceConfig.id}.generateWhen`
            )
          : undefined
      })
    );

    /*
     * Персистентный override из `/source enable|disable` переживает рестарт,
     * но конфиг-файл остаётся источником истины по умолчанию.
     */
    scheduler.add({
      pipeline: pipelines.get(sourceConfig.id) as Pipeline,
      pollIntervalMs: sourceConfig.pollIntervalMs,
      enabled:
        db.getSourceEnabledOverride(sourceConfig.id) ?? sourceConfig.enabled
    });
  }

  await templates.load();

  const commands = new CommandHandler({
    db,
    pipelines,
    scheduler,
    templates,
    logger,
    adminChat: config.adminChat,
    ownerId: config.ownerId,
    aiSources,
    aiConfigured: config.openRouter !== null
  });

  vk.updates.on('message_new', async ctx => {
    try {
      await commands.handle(ctx);
    } catch (error) {
      await logger.error(`Message handler failed: ${toMessage(error)}`);
    }
  });

  await vk.updates.start();

  await reportInitFailures(
    await initializeAll(pipelines),
    pipelines.size,
    logger
  );

  await logger.info(
    [
      'Bot started.',
      `Target chat: ${config.targetChat}`,
      `Admin chat: ${config.adminChat}`,
      `Sources: ${config.sources.map(s => `${s.id} (${s.url})`).join(', ')}`,
      aiSources.length > 0
        ? `AI model: ${aiSources[0]?.modelName} (${aiSources.length} source(s))`
        : 'AI: disabled'
    ].join('\n')
  );

  installShutdownHandlers(vk.updates.stop.bind(vk.updates), db, scheduler);

  scheduler.start();
}

/**
 * Первичная загрузка всех фидов.
 *
 * Ошибка загрузки — проблема ЭТОГО источника, а не всего бота: каждый источник
 * всё равно переживает собственный backoff-цикл, и недоступный фид не должен
 * мешать работать остальным. Поэтому ошибки собираются, а не пробрасываются.
 */
async function initializeAll(pipelines: Map<string, Pipeline>): Promise<string[]> {
  const results = await Promise.all(
    [...pipelines.values()].map(async pipeline => {
      try {
        await pipeline.initialize();

        return null;
      } catch (error) {
        return `${pipeline.sourceName}: ${toMessage(error)}`;
      }
    })
  );

  return results.filter((failure): failure is string => failure !== null);
}

async function reportInitFailures(
  failures: string[],
  total: number,
  logger: Logger
): Promise<void> {
  if (failures.length === 0) {
    return;
  }

  const summary = failures.map(failure => `  - ${failure}`).join('\n');

  await logger.error(
    [
      `Initial feed load failed for ${failures.length} of ${total} source(s):`,
      summary,
      'These sources will retry on their own schedule; the bot keeps running.'
    ].join('\n')
  );

  console.error(`[INIT] Initial feed load failed:\n${summary}`);
}

/**
 * Корректное завершение по SIGINT/SIGTERM.
 *
 * Без него pm2 убивает процесс на середине цикла опроса, и текущий пост может
 * остаться в базе отправленным, хотя в VK сообщения не было.
 */
function installShutdownHandlers(
  stopUpdates: () => Promise<unknown>,
  db: BotDatabase,
  scheduler: Scheduler
): void {
  let stopping = false;

  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }

    stopping = true;
    scheduler.stop();

    console.log(`[SYSTEM] Received ${signal}, shutting down...`);

    stopUpdates()
      .catch(() => {
        // Ошибка остановки long-poll не должна мешать закрыть базу.
      })
      .finally(() => {
        db.close();
        process.exit(0);
      });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(error => {
  console.error('[FATAL]', error);
  process.exit(1);
});