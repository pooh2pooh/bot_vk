import type { BotDatabase } from '../db/database.js';
import type { FeedReader } from './reader.js';
import type { TemplateManager } from '../templates/manager.js';
import type { VKSender } from '../vk/sender.js';
import type { Logger } from '../logger/logger.js';
import type { FeedEntry } from '../types.js';

export class FeedProcessor {
  private firstRun = true;

  constructor(
    private readonly reader: FeedReader,
    private readonly db: BotDatabase,
    private readonly templates: TemplateManager,
    private readonly sender: VKSender,
    private readonly logger: Logger,
    private readonly targetChat: number
  ) {}

  async initialize(): Promise<void> {
    const entries = await this.reader.read();

    let added = 0;

    for (const entry of entries) {
      if (!this.db.hasFeedEntry(entry.id)) {
        this.db.addFeedEntry(entry);
        added++;
      }
    }

    this.logger.info(
      `Feed initialized: ${entries.length} entries, ${added} new entries found.`,
      false
    );

    this.firstRun = false;
  }

  async check(): Promise<number> {
    const entries = await this.reader.read();

    if (entries.length === 0) {
      this.logger.warn('Feed returned no entries.');
      return 0;
    }

    let sent = 0;

    /*
     * Обрабатываем от старых к новым.
     * Если одновременно появилось несколько постов,
     * они попадут в VK в правильном порядке.
     */
    const sorted = [...entries].sort(
      (a, b) =>
        new Date(a.published).getTime() -
        new Date(b.published).getTime()
    );

    for (const entry of sorted) {
      if (this.db.hasFeedEntry(entry.id)) {
        if (this.db.getEntrySentStatus(entry.id)) {
          continue;
        }

        await this.processNewEntry(entry);
        sent++;
        continue;
      }
    }

    if (sent > 0) {
      this.logger.info(
        `Feed check completed: sent ${sent} new post(s).`
      );
    } else {
      this.logger.debug('Feed check: no new entries.');
    }

    return sent;
  }

  async resendLatest(): Promise<FeedEntry> {
    const entries = await this.reader.read();

    if (entries.length === 0) {
      throw new Error('Feed contains no entries.');
    }

    const latest = [...entries].sort(
      (a, b) =>
        new Date(b.published).getTime() -
        new Date(a.published).getTime()
    )[0];

    /*
     * На случай, если запись появилась во внешнем фиде,
     * но ещё не успела попасть в нашу БД.
     */
    if (!this.db.hasFeedEntry(latest.id)) {
      this.db.addFeedEntry(latest);
    }

    const message = this.templates.render(
      'forum_post',
      latest
    );

    await this.sender.send(
      this.targetChat,
      message
    );

    this.logger.info(
      `Latest post resent: "${latest.title}" (${latest.id})`
    );

    return latest;
  }

  private async processNewEntry(
    entry: FeedEntry
  ): Promise<void> {
    this.db.addFeedEntry(entry);

    try {
      const message = this.templates.render(
        'forum_post',
        entry
      );

      await this.sender.send(
        this.targetChat,
        message
      );

      this.db.markSent(entry.id);

      this.logger.info(
        `New post sent: "${entry.title}" by ${entry.author}`
      );
    } catch (error) {
      this.logger.error(
        `Failed to send post "${entry.title}": ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      );

      /*
       * Запись остаётся в БД, но sent_at не устанавливается.
       *
       * Поэтому на следующем запуске она не будет потеряна.
       *
       * Удалять её нельзя.
       */
      throw error;
    }
  }
}
