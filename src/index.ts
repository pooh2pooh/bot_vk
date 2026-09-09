import { mkdir } from 'node:fs/promises';

import { config } from './config.js';
import { BotDatabase } from './db/database.js';

import { createVK } from './vk/client.js';
import { VKSender } from './vk/sender.js';

import { Logger } from './logger/logger.js';

import { FeedReader } from './feed/reader.js';
import { FeedProcessor } from './feed/processor.js';

import { TemplateManager } from './templates/manager.js';

import { CommandHandler } from './commands/handler.js';

async function main(): Promise<void> {
  await mkdir('data', { recursive: true });

  const db = new BotDatabase(
    config.databasePath
  );

  /*
   * Владелец добавляется автоматически.
   *
   * Поэтому после удаления bot.db и нового запуска
   * OWNER_ID снова получает права владельца.
   */
  db.addAdmin(
    config.ownerId,
    'owner'
  );

  const vk = createVK(
    config.vkToken
  );

  const sender = new VKSender(vk);

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

  const reader =
    new FeedReader(
      config.feedUrl,
      config.requestTimeoutMs
    );

  const processor =
    new FeedProcessor(
      reader,
      db,
      templates,
      sender,
      logger,
      config.targetChat
    );

  const commands =
    new CommandHandler(
      db,
      processor,
      templates,
      logger,
      config.adminChat
    );

  /*
   * ВАЖНО:
   *
   * Первый запуск НЕ отправляет старые записи.
   *
   * Все существующие записи только заносятся в БД.
   */
  try {
    await processor.initialize();
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

  /*
   * VK updates.
   */
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

  /*
   * Запускаем long poll.
   */
  await vk.updates.start();

  await logger.info(
    [
      'Bot started.',
      `Target chat: ${config.targetChat}`,
      `Admin chat: ${config.adminChat}`,
      `Feed: ${config.feedUrl}`,
      `Poll interval: ${config.pollIntervalMs} ms`
    ].join('\n')
  );

  /*
   * Основной цикл проверки Atom.
   *
   * setTimeout вместо setInterval:
   * следующий запуск начинается только после
   * завершения предыдущего.
   *
   * Это исключает наложение двух проверок.
   */
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
      await processor.check();
    } catch (error) {
      await logger.error(
        `Feed check failed: ${
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
