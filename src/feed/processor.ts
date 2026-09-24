import type { BotDatabase } from '../db/database.js';
import type { TemplateManager } from '../templates/manager.js';
import type { VKSender } from '../vk/sender.js';
import type { Logger } from '../logger/logger.js';
import type {
  ContentType,
  FeedEntry,
  FeedSource
} from '../types.js';

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
    private readonly source: FeedSource = 'forum'
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
       * Она просто больше не считается кандидатом на автоматическую отправку.
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
        `Feed returned no entries (${this.source}).`,
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

      this.logger.debug(
        [
          `Sending entry (${this.source}):`,
          `"${entry.title}"`,
          `id=${entry.id}`,
          `images=${entry.imageUrls.length}`
        ].join(' ')
      );

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
    // Важно: берём запись из БД, а не первый элемент живого RSS.
    // Поэтому /feed resend-last больше не "прыгает" между постами.
    const latest = this.db.getLatestEntry(
      this.source
    );

    if (!latest) {
      throw new Error(
        `Feed contains no saved entries (${this.source}).`
      );
    }

    const templateType = this.getTemplateType(
      latest
    );
    const message = this.templates.render(
      templateType,
      latest
    );

    await this.sender.send(
      this.targetChat,
      message,
      latest.imageUrls
    );

    this.db.markSent(latest.id);

    this.logger.info(
      `Latest post resent (${this.source}): "${latest.title}" (${latest.id})`
    );

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
      const template = this.getTemplateType(
        entry
      );
      const message = this.templates.render(
        template,
        entry
      );

      await this.sender.send(
        this.targetChat,
        message,
        entry.imageUrls
      );

      this.db.markSent(entry.id);
      this.logger.info(
        [
          `New post sent (${entry.source}):`,
          `"${entry.title}"`,
          `by ${entry.author}`,
          `images=${entry.imageUrls.length}`
        ].join(' ')
      );
    } catch (error) {
      this.logger.error(
        `Failed to send post "${entry.title}" (${entry.source}): ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      );

      /*
       * Запись остаётся в БД.
       * sent_at и ignored_at не устанавливаются.
       * Поэтому следующий check попробует её снова.
       */
      throw error;
    }
  }
}
