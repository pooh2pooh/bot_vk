import type { Context } from 'vk-io';

import type { BotDatabase } from '../db/database.js';
import type { FeedProcessor } from '../feed/processor.js';
import type { TemplateManager } from '../templates/manager.js';
import type { Logger } from '../logger/logger.js';

export class CommandHandler {
  constructor(
    private readonly db: BotDatabase,
    private readonly processor: FeedProcessor,
    private readonly templates: TemplateManager,
    private readonly logger: Logger,
    private readonly adminChat: number
  ) {}

  async handle(ctx: Context): Promise<void> {
    if (ctx.peerId !== this.adminChat) {
      return;
    }

    const text = ctx.text?.trim();

    if (!text?.startsWith('/')) {
      return;
    }

    const senderId = ctx.senderId;

    if (!this.db.isAdmin(senderId)) {
      await ctx.send('⛔ У вас нет прав администратора.');
      return;
    }

    const [command, ...args] = text.split(/\s+/);

    try {
      switch (command.toLowerCase()) {
        case '/help':
          await this.help(ctx);
          break;

        case '/status':
          await this.status(ctx);
          break;

        case '/feed':
          await this.feed(ctx, args);
          break;

        case '/admin':
          await this.admin(ctx, args);
          break;

        case '/template':
          await this.template(ctx, args);
          break;

        default:
          await ctx.send(
            'Неизвестная команда.\n\nИспользуй /help'
          );
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      this.logger.error(
        `Command ${command} failed for ${senderId}: ${message}`
      );

      await ctx.send(
        `❌ Ошибка выполнения команды:\n${message}`
      );
    }
  }

  private async help(ctx: Context): Promise<void> {
    await ctx.send(
      [
        '🤖 Команды бота',
        '',
        '/status — состояние бота',
        '/feed check — проверить Atom сейчас',
        '/feed resend-last — повторно отправить последний пост',
        '',
        '/admin list — список администраторов',
        '/admin add ID — добавить администратора',
        '/admin remove ID — удалить администратора',
        '',
        '/template reload — перечитать шаблоны'
      ].join('\n')
    );
  }

  private async status(ctx: Context): Promise<void> {
    const stats = this.db.getStats();

    await ctx.send(
      [
        '📊 Статус',
        '',
        `Записей в БД: ${stats.totalEntries}`,
        `Отправлено: ${stats.sentEntries}`,
        `Администраторов: ${stats.admins}`
      ].join('\n')
    );
  }

  private async feed(
    ctx: Context,
    args: string[]
  ): Promise<void> {
    const action = args[0];

    switch (action) {
      case 'check': {
        await ctx.send('🔄 Проверяю Atom...');

        const count = await this.processor.check();

        await ctx.send(
          count > 0
            ? `✅ Отправлено новых постов: ${count}`
            : '✅ Новых постов нет.'
        );

        return;
      }

      case 'resend-last': {
        await ctx.send(
          '🔄 Получаю последний пост из Atom...'
        );

        const entry =
          await this.processor.resendLatest();

        await ctx.send(
          `✅ Последний пост повторно отправлен:\n${entry.title}`
        );

        return;
      }

      default:
        await ctx.send(
          'Использование:\n' +
          '/feed check\n' +
          '/feed resend-last'
        );
    }
  }

  private async admin(
    ctx: Context,
    args: string[]
  ): Promise<void> {
    const action = args[0];

    switch (action) {
      case 'list': {
        const admins = this.db.getAdmins();

        const lines = admins.map(
          admin =>
            `${admin.role === 'owner' ? '👑' : '👤'} ` +
            `${admin.userId} — ${admin.role}`
        );

        await ctx.send(
          [
            '👥 Администраторы',
            '',
            ...lines
          ].join('\n')
        );

        return;
      }

      case 'add': {
        if (!this.db.isOwner(ctx.senderId)) {
          await ctx.send(
            '⛔ Добавлять администраторов может только владелец.'
          );
          return;
        }

        const id = Number(args[1]);

        if (!Number.isInteger(id) || id <= 0) {
          await ctx.send(
            'Использование: /admin add ID'
          );
          return;
        }

        this.db.addAdmin(id, 'admin');

        await ctx.send(
          `✅ Пользователь ${id} добавлен в администраторы.`
        );

        this.logger.info(
          `Admin ${ctx.senderId} added administrator ${id}.`
        );

        return;
      }

      case 'remove': {
        if (!this.db.isOwner(ctx.senderId)) {
          await ctx.send(
            '⛔ Удалять администраторов может только владелец.'
          );
          return;
        }

        const id = Number(args[1]);

        if (!Number.isInteger(id) || id <= 0) {
          await ctx.send(
            'Использование: /admin remove ID'
          );
          return;
        }

        if (id === ctx.senderId) {
          await ctx.send(
            '⛔ Нельзя удалить самого себя.'
          );
          return;
        }

        if (id === Number(process.env.OWNER_ID)) {
          await ctx.send(
            '⛔ Нельзя удалить владельца.'
          );
          return;
        }

        this.db.removeAdmin(id);

        await ctx.send(
          `✅ Пользователь ${id} удалён из администраторов.`
        );

        this.logger.info(
          `Admin ${ctx.senderId} removed administrator ${id}.`
        );

        return;
      }

      default:
        await ctx.send(
          'Использование:\n' +
          '/admin list\n' +
          '/admin add ID\n' +
          '/admin remove ID'
        );
    }
  }

  private async template(
    ctx: Context,
    args: string[]
  ): Promise<void> {
    if (args[0] !== 'reload') {
      await ctx.send(
        'Использование:\n/template reload'
      );
      return;
    }

    await this.templates.load();

    await ctx.send(
      '✅ Шаблоны успешно перечитаны.'
    );

    this.logger.info(
      `Templates reloaded by ${ctx.senderId}.`
    );
  }
}
