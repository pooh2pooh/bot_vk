import { mkdir } from 'node:fs/promises';

import { config } from './config.js';
import { BotDatabase } from './db/database.js';

import { createVK } from './vk/client.js';
import { VKSender } from './vk/sender.js';

import { Logger } from './logger/logger.js';

import { FeedReader } from './feed/reader.js';
import { ScreenshotFeedReader } from './feed/screenshot-reader.js';
import { FeedProcessor } from './feed/processor.js';

import { TemplateManager } from './templates/manager.js';
import { CommandHandler } from './commands/handler.js';
import { OpenRouterCommentService } from './ai/openrouter.js';

async function main(): Promise<void> {
  await mkdir('data', { recursive: true });

  const db = new BotDatabase(
    config.databasePath
  );

  db.addAdmin(
    config.ownerId,
    'owner'
  );

  const vk = createVK(
    config.vkToken
  );

  const sender = new VKSender(
    vk,
    3,
    config.imageDownloadTimeoutMs,
    config.vkUploadTimeoutMs
  );
  const logger = new Logger(
    sender,
    config.adminChat,
    config.logLevel as
      | 'debug'
      | 'info'
      | 'warn'
      | 'error'
  );

  const templates =
    new TemplateManager(
      config.templatesPath
    );

  await templates.load();

  const ai = new OpenRouterCommentService(
    config.openRouterApiKey,
    config.openRouterModel,
    config.openRouterModelName,
    config.openRouterPromptPath,
    config.openRouterTimeoutMs,
    config.openRouterMaxTokens
  );

  await ai.loadPrompt();

  const forumReader =
    new FeedReader(
      config.feedUrl,
      config.requestTimeoutMs
    );

  const screenshotReader =
    new ScreenshotFeedReader(
      config.screenshotFeedUrl,
      config.requestTimeoutMs
    );

  const forumProcessor =
    new FeedProcessor(
      forumReader,
      db,
      templates,
      sender,
      logger,
      config.targetChat,
      'forum'
    );

  const screenshotProcessor =
    new FeedProcessor(
      screenshotReader,
      db,
      templates,
      sender,
      logger,
      config.targetChat,
      'screenshots',
      ai
    );

  const commands =
    new CommandHandler(
      db,
      forumProcessor,
      templates,
      logger,
      config.adminChat,
      ai
    );

  try {
    await forumProcessor.initialize();
    await screenshotProcessor.initialize();
  } catch (error) {
    await logger.error(
      `Initial feed load failed: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
    throw error;
  }

  vk.updates.on(
    'message_new',
    async ctx => {
      try {
        await commands.handle(ctx);
      } catch (error) {
        await logger.error(
          `Message handler failed: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`
        );
      }
    }
  );

  await vk.updates.start();

  await logger.info(
    [
      'Bot started.',
      `Target chat: ${config.targetChat}`,
      `Admin chat: ${config.adminChat}`,
      `Forum feed: ${config.feedUrl}`,
      `Screenshots feed: ${config.screenshotFeedUrl}`,
      `AI model: ${config.openRouterModel}`,
      `Poll interval: ${config.pollIntervalMs} ms`
    ].join('\n')
  );

  let stopped = false;

  const shutdown = async (
    signal: string
  ): Promise<void> => {
    if (stopped) {
      return;
    }

    stopped = true;

    console.log(
      `[SYSTEM] Received ${signal}, shutting down...`
    );

    try {
      await vk.updates.stop();
    } catch {
      // Игнорируем ошибки остановки VK.
    }

    db.close();
    process.exit(0);
  };

  process.once(
    'SIGINT',
    () => void shutdown('SIGINT')
  );

  process.once(
    'SIGTERM',
    () => void shutdown('SIGTERM')
  );

  const loop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    try {
      await forumProcessor.check();
    } catch (error) {
      await logger.error(
        `Forum feed check failed: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      );
    }

    try {
      await screenshotProcessor.check();
    } catch (error) {
      await logger.error(
        `Screenshot feed check failed: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      );
    }

    if (!stopped) {
      setTimeout(
        loop,
        config.pollIntervalMs
      );
    }
  };

  setTimeout(
    loop,
    config.pollIntervalMs
  );
}

main().catch(error => {
  console.error(
    '[FATAL]',
    error
  );

  process.exit(1);
});
