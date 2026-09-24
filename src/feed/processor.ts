import type { BotDatabase } from '../db/database.js';
import type { TemplateManager } from '../templates/manager.js';
import type { VKSender } from '../vk/sender.js';
import type { Logger } from '../logger/logger.js';
import type {
  ContentType,
  FeedEntry,
  FeedSource
} from '../types.js';
import type { OpenRouterCommentService } from '../ai/openrouter.js';

export interface FeedSourceReader {
  read(): Promise<FeedEntry[]>;
}

export class FeedProcessor {
  constructor(
    private readonly reader: FeedSourceReader,
    private readonly db: BotDatabase,
    private readonly templates: TemplateManager,
    private readonly sender: VKSender,
    private readonly logger: Logger,
    private readonly targetChat: number,
    private readonly source: FeedSource = 'forum',
    private readonly ai?: OpenRouterCommentService
  ) {}

  async initialize(): Promise<void> {
    const entries = await this.reader.read();

    let added = 0;
    let ignored = 0;

    for (const entry of entries) {
      if (!this.db.hasFeedEntry(entry.id)) {
        this.db.addFeedEntry(entry);
        added++;
      }

      /*
       * При старте текущий снимок фида считается уже обработанным.
       * Это НЕ ставит sent_at: запись не считается отправленной в VK.
       */
      if (
        !this.db.getEntrySentStatus(entry.id) &&
        !this.db.getEntryIgnoredStatus(entry.id)
      ) {
        this.db.markIgnored(entry.id);
        ignored++;
      }
    }

    this.logger.info(
      [
        `Feed initialized (${this.source}): ${entries.length} entries.`,
        `Added: ${added}.`,
        `Ignored on startup: ${ignored}.`
      ].join(' '),
      false
    );
  }

  async check(): Promise<number> {
    const entries = await this.reader.read();

    if (entries.length === 0) {
      this.logger.warn(
        `Feed returned no entries (${this.source}).`
      );
      return 0;
    }

    let sent = 0;
    const sorted = [...entries].sort(
      (a, b) =>
        new Date(a.published).getTime() -
        new Date(b.published).getTime()
    );

    for (const entry of sorted) {
      const handled =
        this.db.getEntryHandledStatus(entry.id);

      if (handled) {
        this.logger.debug(
          [
            `Skip handled entry (${this.source}):`,
            `"${entry.title}"`,
            `id=${entry.id}`,
            `sent=${this.db.getEntrySentStatus(entry.id)}`,
            `ignored=${this.db.getEntryIgnoredStatus(entry.id)}`
          ].join(' ')
        );
        continue;
      }

      await this.processNewEntry(entry);
      sent++;
    }

    if (sent > 0) {
      this.logger.info(
        `Feed check completed (${this.source}): sent ${sent} new post(s).`
      );
    } else {
      this.logger.debug(
        `Feed check (${this.source}): no new entries.`
      );
    }

    return sent;
  }

  async resendLatest(): Promise<FeedEntry> {
    const latest = this.db.getLatestEntry(
      this.source
    );

    if (!latest) {
      throw new Error(
        `Feed contains no saved entries (${this.source}).`
      );
    }

    const prepared =
      await this.prepareEntry(latest);

    const message = this.templates.render(
      this.getTemplateType(latest),
      prepared.entry
    );

    await this.sender.send(
      this.targetChat,
      message,
      latest.imageUrls
    );

    this.db.markSent(latest.id);

    if (prepared.ai) {
      this.logAiSuccess(
        latest,
        prepared.ai.durationMs,
        true
      );
    } else {
      this.logger.info(
        [
          `Latest post resent (${this.source}):`,
          `"${latest.title}"`,
          prepared.aiFailed ? 'AI: fallback на оригинальный текст' : ''
        ].filter(Boolean).join(' ')
      );
    }

    return latest;
  }

  private getTemplateType(
    entry: FeedEntry
  ): ContentType {
    return entry.source === 'screenshots'
      ? 'screenshot_post'
      : 'forum_post';
  }

  private async processNewEntry(
    entry: FeedEntry
  ): Promise<void> {
    this.db.addFeedEntry(entry);

    try {
      const prepared =
        await this.prepareEntry(entry);

      const message = this.templates.render(
        this.getTemplateType(entry),
        prepared.entry
      );

      await this.sender.send(
        this.targetChat,
        message,
        entry.imageUrls
      );

      this.db.markSent(entry.id);

      if (prepared.ai) {
        this.logAiSuccess(
          entry,
          prepared.ai.durationMs,
          false
        );
      } else {
        this.logger.info(
          [
            `New post sent (${entry.source}):`,
            `"${entry.title}"`,
            `by ${entry.author}`,
            `images=${entry.imageUrls.length}`,
            prepared.aiFailed ? 'AI: fallback на оригинальный текст' : ''
          ].filter(Boolean).join(' ')
        );
      }
    } catch (error) {
      // Ошибку логирует внешний цикл, чтобы не дублировать
      // одно и то же событие в админ-чате.
      throw error;
    }
  }

  private async prepareEntry(
    entry: FeedEntry
  ): Promise<{
    entry: FeedEntry;
    ai: Awaited<ReturnType<OpenRouterCommentService['generate']>> | null;
    aiFailed: boolean;
  }> {
    if (
      entry.source !== 'screenshots' ||
      !this.ai
    ) {
      return {
        entry,
        ai: null,
        aiFailed: false
      };
    }

    try {
      const ai = await this.ai.generate(entry);

      return {
        entry: {
          ...entry,
          // Автором комментария считается модель.
          author: ai.model,
          // Вместо оригинального текста показываем комментарий ИИ.
          content: ai.comment
        },
        ai,
        aiFailed: false
      };
    } catch (error) {
      // AI не должен блокировать пересылку самого скриншота.
      this.logger.error(
        `AI comment failed for \"${entry.title}\": ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      );

      return {
        entry,
        ai: null,
        aiFailed: true
      };
    }
  }

  private logAiSuccess(
    entry: FeedEntry,
    durationMs: number,
    resend: boolean
  ): void {
    this.logger.info(
      [
        '📸 Скриншот переслан',
        `Название: ${entry.title}`,
        `Модель: ${this.ai?.getModelName() ?? 'AI'}`,
        `Время ответа AI: ${(durationMs / 1000).toFixed(2)} с`,
        resend ? 'Режим: повторная отправка' : 'Режим: автоматическая отправка'
      ].join('\n')
    );
  }
}
