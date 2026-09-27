import { mkdir } from 'node:fs/promises';

import { loadConfig } from './config/index.js';
import { BotDatabase } from './db/database.js';

import { createVK } from './vk/client.js';
import { VKSender } from './vk/sender.js';

import { Logger } from './logger/logger.js';

import { TemplateManager } from './templates/manager.js';
import { CommandHandler } from './commands/handler.js';

import { buildRegistries, resolveEnricherForSource } from './registries.js';
import { SourcePipeline } from './pipeline/source-pipeline.js';
import { Scheduler } from './pipeline/scheduler.js';

async function main(): Promise<void> {
  const config = await loadConfig();

  await mkdir('data', { recursive: true });

  const db = new BotDatabase(config.databasePath);
  db.addAdmin(config.ownerId, 'owner');

  const vk = createVK(config.vkToken);

  const sender = new VKSender(
    vk,
    3,
    config.imageDownloadTimeoutMs,
    config.vkUploadTimeoutMs
  );

  const logger = new Logger(sender, config.adminChat, config.logLevel);

  const templates = new TemplateManager();
  const registries = buildRegistries(config);

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
      targetChat: config.targetChat
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

  try {
    await Promise.all(
      [...pipelines.values()].map(pipeline => pipeline.initialize())
    );
  } catch (error) {
    await logger.error(
      `Initial feed load failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    throw error;
  }

  vk.updates.on('message_new', async ctx => {
    try {
      await commands.handle(ctx);
    } catch (error) {
      await logger.error(
        `Message handler failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
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
