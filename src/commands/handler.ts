import type { Context } from 'vk-io';

import type { OpenRouterEnricher } from '../enrich/openrouter-enricher.js';
import type { BotDatabase } from '../db/database.js';
import type { Logger } from '../logger/logger.js';
import type { Scheduler } from '../pipeline/scheduler.js';
import type { SourcePipeline } from '../pipeline/source-pipeline.js';
import type { TemplateManager } from '../templates/manager.js';
import { toMessage } from '../utils/to-message.js';

export interface CommandHandlerOptions {
  db: BotDatabase;
  pipelines: Map<string, SourcePipeline>;
  scheduler: Scheduler;
  templates: TemplateManager;
  logger: Logger;
  adminChat: number;
  ownerId: number;
  openRouterEnricher: OpenRouterEnricher | null;
}

export class CommandHandler {
  constructor(private readonly opts: CommandHandlerOptions) {}

  async handle(ctx: Context): Promise<void> {
    if (ctx.peerId !== this.opts.adminChat) {
      return;
    }

    const text = ctx.text?.trim();

    if (!text?.startsWith('/')) {
      return;
    }

    const senderId = ctx.senderId;

    if (!this.opts.db.isAdmin(senderId)) {
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
        case '/source':
          await this.source(ctx, args);
          break;
        case '/admin':
          await this.admin(ctx, args);
          break;
        case '/template':
          await this.template(ctx, args);
          break;
        case '/ai':
          await this.aiCommand(ctx, args);
          break;
        default:
          await ctx.send('Неизвестная команда.\n\nИспользуй /help');
      }
    } catch (error) {
      const message = toMessage(error);

      this.opts.logger.error(
        `Command ${command} failed for ${senderId}: ${message}`
      );

      await ctx.send(`❌ Ошибка выполнения команды:\n${message}`);
    }
  }

  private async help(ctx: Context): Promise<void> {
    await ctx.send(
      [
        '🤖 Команды бота',
        '',
        '/status — состояние бота',
        '',
        '/source list — список источников и их статус',
        '/source check ID — проверить источник сейчас',
        '/source resend-last ID — повторно отправить последний пост источника',
        '/source enable ID — включить источник',
        '/source disable ID — выключить источник',
        '',
        '/admin list — список администраторов',
        '/admin add ID — добавить администратора',
        '/admin remove ID — удалить администратора',
        '',
        '/template reload [ID] — перечитать шаблоны (все или один источник)',
        '',
        '/ai status — текущая AI-модель',
        '/ai reload — перечитать AI-промпт'
      ].join('\n')
    );
  }

  private async status(ctx: Context): Promise<void> {
    const stats = this.opts.db.getStats();
    const perSource = this.opts.db.getEntriesPerSource();

    const sourceLines = this.opts.scheduler
      .list()
      .map(
        source =>
          `${source.enabled ? '🟢' : '⚪'} ${source.sourceName} (${source.sourceId}): ` +
          `${perSource[source.sourceId] ?? 0} записей`
      );

    await ctx.send(
      [
        '📊 Статус',
        '',
        `Записей в БД: ${stats.totalEntries}`,
        `Отправлено: ${stats.sentEntries}`,
        `Администраторов: ${stats.admins}`,
        '',
        '📡 Источники',
        ...sourceLines
      ].join('\n')
    );
  }

  private getPipeline(id: string | undefined): SourcePipeline {
    if (!id) {
      throw new Error('Укажи id источника. Список: /source list');
    }

    const pipeline = this.opts.pipelines.get(id);

    if (!pipeline) {
      throw new Error(
        `Источник "${id}" не найден. Список: /source list`
      );
    }

    return pipeline;
  }

  private async source(ctx: Context, args: string[]): Promise<void> {
    const [action, id] = args;

    switch (action) {
      case 'list': {
        const lines = this.opts.scheduler
          .list()
          .map(
            source =>
              `${source.enabled ? '🟢' : '⚪'} ${source.sourceId} — ${source.sourceName}`
          );

        await ctx.send(['📡 Источники', '', ...lines].join('\n'));
        return;
      }

      case 'check': {
        const pipeline = this.getPipeline(id);
        await ctx.send(`🔄 Проверяю "${id}"...`);
        const count = await pipeline.check();

        await ctx.send(
          count > 0
            ? `✅ Отправлено новых постов: ${count}`
            : '✅ Новых постов нет.'
        );
        return;
      }

      case 'resend-last': {
        const pipeline = this.getPipeline(id);
        await ctx.send(`🔄 Получаю последний пост "${id}"...`);
        const entry = await pipeline.resendLatest();

        await ctx.send(`✅ Последний пост повторно отправлен:\n${entry.title}`);
        return;
      }

      case 'enable': {
        const { sourceId } = this.getPipeline(id);
        this.opts.scheduler.setEnabled(sourceId, true);
        this.opts.db.setSourceEnabledOverride(sourceId, true);
        await ctx.send(`✅ Источник "${sourceId}" включён.`);
        this.opts.logger.info(`Source ${sourceId} enabled by ${ctx.senderId}.`);
        return;
      }

      case 'disable': {
        const { sourceId } = this.getPipeline(id);
        this.opts.scheduler.setEnabled(sourceId, false);
        this.opts.db.setSourceEnabledOverride(sourceId, false);
        await ctx.send(`✅ Источник "${sourceId}" выключен.`);
        this.opts.logger.info(`Source ${sourceId} disabled by ${ctx.senderId}.`);
        return;
      }

      default:
        await ctx.send(
          'Использование:\n' +
            '/source list\n' +
            '/source check ID\n' +
            '/source resend-last ID\n' +
            '/source enable ID\n' +
            '/source disable ID'
        );
    }
  }

  private async aiCommand(ctx: Context, args: string[]): Promise<void> {
    if (!this.opts.openRouterEnricher) {
      await ctx.send('AI (OpenRouter) не настроен: нет OPENROUTER_API_KEY.');
      return;
    }

    switch (args[0]) {
      case 'status':
        await ctx.send(
          [
            '🤖 AI',
            '',
            `Модель: ${this.opts.openRouterEnricher.getModelName()}`,
            `ID: ${this.opts.openRouterEnricher.getModel()}`,
            `Промпт: ${this.opts.openRouterEnricher.getPromptPath()}`
          ].join('\n')
        );
        return;

      case 'reload':
        await this.opts.openRouterEnricher.loadPrompt();
        await ctx.send('✅ AI-промпт перечитан.');
        this.opts.logger.info(`AI prompt reloaded by ${ctx.senderId}.`);
        return;

      default:
        await ctx.send('Использование:\n/ai status\n/ai reload');
    }
  }

  private async admin(ctx: Context, args: string[]): Promise<void> {
    const action = args[0];

    switch (action) {
      case 'list': {
        const admins = this.opts.db.getAdmins();
        const lines = admins.map(
          admin =>
            `${admin.role === 'owner' ? '👑' : '👤'} ${admin.userId} — ${admin.role}`
        );

        await ctx.send(['👥 Администраторы', '', ...lines].join('\n'));
        return;
      }

      case 'add': {
        if (!this.opts.db.isOwner(ctx.senderId)) {
          await ctx.send('⛔ Добавлять администраторов может только владелец.');
          return;
        }

        const id = Number(args[1]);

        if (!Number.isInteger(id) || id <= 0) {
          await ctx.send('Использование: /admin add ID');
          return;
        }

        this.opts.db.addAdmin(id, 'admin');
        await ctx.send(`✅ Пользователь ${id} добавлен в администраторы.`);
        this.opts.logger.info(`Admin ${ctx.senderId} added administrator ${id}.`);
        return;
      }

      case 'remove': {
        if (!this.opts.db.isOwner(ctx.senderId)) {
          await ctx.send('⛔ Удалять администраторов может только владелец.');
          return;
        }

        const id = Number(args[1]);

        if (!Number.isInteger(id) || id <= 0) {
          await ctx.send('Использование: /admin remove ID');
          return;
        }

        if (id === ctx.senderId) {
          await ctx.send('⛔ Нельзя удалить самого себя.');
          return;
        }

        if (id === this.opts.ownerId) {
          await ctx.send('⛔ Нельзя удалить владельца.');
          return;
        }

        this.opts.db.removeAdmin(id);
        await ctx.send(`✅ Пользователь ${id} удалён из администраторов.`);
        this.opts.logger.info(`Admin ${ctx.senderId} removed administrator ${id}.`);
        return;
      }

      default:
        await ctx.send(
          'Использование:\n/admin list\n/admin add ID\n/admin remove ID'
        );
    }
  }

  private async template(ctx: Context, args: string[]): Promise<void> {
    if (args[0] !== 'reload') {
      await ctx.send('Использование:\n/template reload [ID]');
      return;
    }

    const id = args[1];

    if (id) {
      this.getPipeline(id);
      await this.opts.templates.loadOne(id);
      await ctx.send(`✅ Шаблон "${id}" перечитан.`);
    } else {
      await this.opts.templates.load();
      await ctx.send('✅ Все шаблоны перечитаны.');
    }

    this.opts.logger.info(`Templates reloaded by ${ctx.senderId}.`);
  }
}
