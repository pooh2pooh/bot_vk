import type { BotDatabase } from '../db/database.js';
import type { Enricher } from '../core/enricher.js';
import type { SourceAdapter } from '../core/source-adapter.js';
import type { FeedEntry } from '../core/types.js';
import type { Logger } from '../logger/logger.js';
import type { TemplateManager } from '../templates/manager.js';
import type { VKSender } from '../vk/sender.js';

export interface SourcePipelineOptions {
  sourceId: string;
  sourceName: string;
  adapter: SourceAdapter;
  enricher: Enricher;
  db: BotDatabase;
  templates: TemplateManager;
  sender: VKSender;
  logger: Logger;
  targetChat: number;
}

/**
 * Полный цикл обработки одного источника. Не знает, что такое RSS, LOR или
 * OpenRouter — всё специфичное приходит через SourceAdapter/Enricher.
 * Именно поэтому добавление нового источника не требует правки этого файла.
 */
export class SourcePipeline {
  readonly sourceId: string;
  readonly sourceName: string;

  constructor(private readonly options: SourcePipelineOptions) {
    this.sourceId = options.sourceId;
    this.sourceName = options.sourceName;
  }

  async initialize(): Promise<void> {
    const entries = await this.options.adapter.fetch();

    let added = 0;
    let ignored = 0;

    for (const entry of entries) {
      if (!this.options.db.hasFeedEntry(entry.id)) {
        this.options.db.addFeedEntry(entry);
        added++;
      }

      /*
       * При старте текущий снимок фида считается уже обработанным.
       * Это НЕ ставит sent_at: запись не считается отправленной в VK.
       */
      if (
        !this.options.db.getEntrySentStatus(entry.id) &&
        !this.options.db.getEntryIgnoredStatus(entry.id)
      ) {
        this.options.db.markIgnored(entry.id);
        ignored++;
      }
    }

    this.options.logger.info(
      [
        `Feed initialized (${this.sourceName}): ${entries.length} entries.`,
        `Added: ${added}.`,
        `Ignored on startup: ${ignored}.`
      ].join(' '),
      false
    );
  }

  async check(): Promise<number> {
    const entries = await this.options.adapter.fetch();

    if (entries.length === 0) {
      this.options.logger.warn(`Feed returned no entries (${this.sourceName}).`);
      return 0;
    }

    let sent = 0;
    const sorted = [...entries].sort(
      (a, b) => new Date(a.published).getTime() - new Date(b.published).getTime()
    );

    for (const entry of sorted) {
      const handled = this.options.db.getEntryHandledStatus(entry.id);

      if (handled) {
        continue;
      }

      await this.processNewEntry(entry);
      sent++;
    }

    if (sent > 0) {
      this.options.logger.info(
        `Feed check completed (${this.sourceName}): sent ${sent} new post(s).`
      );
    } else {
      this.options.logger.debug(`Feed check (${this.sourceName}): no new entries.`);
    }

    return sent;
  }

  async resendLatest(): Promise<FeedEntry> {
    const latest = this.options.db.getLatestEntry(this.sourceId);

    if (!latest) {
      throw new Error(`Feed contains no saved entries (${this.sourceName}).`);
    }

    const prepared = await this.prepareEntry(latest);
    const message = this.options.templates.render(this.sourceId, prepared.entry);

    await this.options.sender.send(this.options.targetChat, message, latest.imageUrls);
    this.logImageFailures(latest);
    this.options.db.markSent(latest.id);

    this.options.logger.info(
      [
        `Latest post resent (${this.sourceName}):`,
        `"${latest.title}"`,
        prepared.enrichFailed ? 'enrich: fallback на исходное содержимое' : ''
      ]
        .filter(Boolean)
        .join(' ')
    );

    return latest;
  }

  private async processNewEntry(entry: FeedEntry): Promise<void> {
    this.options.db.addFeedEntry(entry);

    // Ошибку пробрасываем наружу: внешний планировщик отвечает за backoff/лог,
    // чтобы одна и та же ошибка не логировалась дважды.
    const prepared = await this.prepareEntry(entry);
    const message = this.options.templates.render(this.sourceId, prepared.entry);

    await this.options.sender.send(this.options.targetChat, message, entry.imageUrls);
    this.logImageFailures(entry);
    this.options.db.markSent(entry.id);

    this.options.logger.info(
      [
        `New post sent (${this.sourceName}):`,
        `"${entry.title}"`,
        `by ${entry.author}`,
        `images=${entry.imageUrls.length}`,
        prepared.enrichFailed ? 'enrich: fallback на исходное содержимое' : ''
      ]
        .filter(Boolean)
        .join(' ')
    );
  }

  private async prepareEntry(
    entry: FeedEntry
  ): Promise<{ entry: FeedEntry; enrichFailed: boolean }> {
    try {
      const result = await this.options.enricher.enrich(entry);
      return { entry: result.entry, enrichFailed: false };
    } catch (error) {
      // Обогащение (например, AI) не должно блокировать пересылку самого поста.
      this.options.logger.error(
        `Enrich failed for "${entry.title}" (${this.sourceName}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      return { entry, enrichFailed: true };
    }
  }

  private logImageFailures(entry: FeedEntry): void {
    for (const failure of this.options.sender.consumeImageErrors()) {
      this.options.logger.error(
        [
          '🖼 Ошибка загрузки изображения',
          `Источник: ${this.sourceName}`,
          `Пост: ${entry.title}`,
          `URL: ${failure.url}`,
          `Причина: ${failure.message}`
        ].join('\n')
      );
    }
  }
}
