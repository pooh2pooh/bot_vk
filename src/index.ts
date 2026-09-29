import { loadConfig } from './config/index.js';
import { BotDatabase } from './db/database.js';

import { createVK } from './vk/client.js';
import { VKSender } from './vk/sender.js';

import { Logger } from './logger/logger.js';

import { TemplateManager } from './templates/manager.js';
import { CommandHandler } from './commands/handler.js';

import { buildRegistries, resolveEnricherForSource, validateSources } from './registries.js';
import { SourcePipeline } from './pipeline/source-pipeline.js';
import { Scheduler } from './pipeline/scheduler.js';
import { toMessage } from './utils/to-message.js';

async function main(): Promise<void> {
  const config = await loadConfig();

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
  const registries = buildRegistries(config);

  // Проверяем sources.yml до сборки пайплайнов: опечатка в imageExtractor или
  // enrich: openrouter без OPENROUTER_API_KEY должна дать один понятный список
  // проблем, а не падение где-то в середине цикла.
  validateSources(registries, config.sources);

  if (registries.openRouterEnricher) {
    await registries.openRouterEnricher.loadPrompt();
  }

  // --- Собираем пайплайн для каждого источника из config/sources.yml. ---
  // Добавление/удаление источника — это только правка YAML, этот цикл
  // не меняется вне зависимости от того, сколько источников настроено.
  const pipelines = new Map<string, SourcePipeline>();
  const scheduler = new Scheduler(logger);

  for (const sourceConfig of config.sources) {
    templates.register(sourceConfig.id, sourceConfig.template);

    const adapter = registries.sourceAdapters.create(sourceConfig);
    const enricher = await resolveEnricherForSource(registries, config, sourceConfig);

    const pipeline = new SourcePipeline({
      sourceId: sourceConfig.id,
      sourceName: sourceConfig.name,
      adapter,
      enricher,
      db,
      templates,
      sender,
      logger,
      targetChat: config.targetChat,
      fallbackTextLimit: sourceConfig.fallbackTextLimit,
      /*
       * Текст для fallback'а берём у ЭКСТРАКТОРА источника, а не у адаптера:
       * именно стратегия сайта умеет ходить на страницу поста. Универсально,
       * без упоминания pingvinus: если стратегия этого не умеет, остаётся
       * текст из фида (возможно, пустой).
       */
      fetchOriginalText: link => {
        const extractor = registries.imageExtractors.resolve(
          sourceConfig.imageExtractor
        );

        return extractor.extractTextFromUrl
          ? extractor.extractTextFromUrl(link)
          : Promise.resolve('');
      }
    });

    pipelines.set(sourceConfig.id, pipeline);

    // Персистентный override из /source enable|disable переживает рестарт,
    // но конфиг-файл остаётся единственным источником истины по умолчанию.
    const persistedEnabled = db.getSourceEnabledOverride(sourceConfig.id);
    const enabled = persistedEnabled ?? sourceConfig.enabled;

    scheduler.add({
      pipeline,
      pollIntervalMs: sourceConfig.pollIntervalMs ?? config.defaultPollIntervalMs,
      enabled
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
    openRouterEnricher: registries.openRouterEnricher
  });

  // Ошибка первичной загрузки фида — проблема ЭТОГО источника, а не всего
  // бота: каждый источник всё равно переживает собственный backoff-цикл, и
  // недоступный фид не должен мешать работать остальным.
  const initFailures = (
    await Promise.all(
      [...pipelines.values()].map(async pipeline => {
        try {
          await pipeline.initialize();
          return null;
        } catch (error) {
          return { name: pipeline.sourceName, message: toMessage(error) };
        }
      })
    )
  ).filter(failure => failure !== null);

  if (initFailures.length > 0) {
    const summary = initFailures
      .map(failure => `  - ${failure.name}: ${failure.message}`)
      .join('\n');

    await logger.error(
      [
        `Initial feed load failed for ${initFailures.length} of ${pipelines.size} source(s):`,
        summary,
        'These sources will retry on their own schedule; the bot keeps running.'
      ].join('\n')
    );

    console.error(`[INIT] Initial feed load failed:\n${summary}`);
  }

  vk.updates.on('message_new', async ctx => {
    try {
      await commands.handle(ctx);
    } catch (error) {
      await logger.error(`Message handler failed: ${toMessage(error)}`);
    }
  });

  await vk.updates.start();

  await logger.info(
    [
      'Bot started.',
      `Target chat: ${config.targetChat}`,
      `Admin chat: ${config.adminChat}`,
      `Sources: ${config.sources.map(s => `${s.id} (${s.url})`).join(', ')}`,
      registries.openRouterEnricher
        ? `AI model: ${registries.openRouterEnricher.getModel()}`
        : 'AI: disabled'
    ].join('\n')
  );

  let stopped = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;
    scheduler.stop();

    console.log(`[SYSTEM] Received ${signal}, shutting down...`);

    try {
      await vk.updates.stop();
    } catch {
      // Игнорируем ошибки остановки VK.
    }

    db.close();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  scheduler.start();
}

main().catch(error => {
  console.error('[FATAL]', error);
  process.exit(1);
});
