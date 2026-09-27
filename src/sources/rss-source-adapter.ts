import Parser from 'rss-parser';

import type { ImageExtractor } from '../core/image-extractor.js';
import type { SourceAdapter } from '../core/source-adapter.js';
import type { FeedEntry } from '../core/types.js';
import type { AtomItem } from './atom-item.js';
import {
  fetchText,
  getAuthor,
  itemHtmlContent,
  itemPublished,
  itemUpdated,
  normalizeText
} from './text-utils.js';

export interface RssSourceAdapterOptions {
  sourceId: string;
  url: string;
  timeoutMs: number;
  userAgent: string;
  imageExtractor: ImageExtractor;
  /** Если true — записи без картинок отбрасываются (напр. "скриншотные" источники). */
  requireImages: boolean;
  /**
   * Необязательный кастомный экстрактор текста описания (по умолчанию —
   * обычная нормализация HTML). Нужен источникам вроде LOR, где из описания
   * дополнительно вырезаются блоки картинок/тегов.
   */
  extractDescription?: (item: AtomItem) => string;
}

/**
 * Один универсальный адаптер для любого RSS/Atom источника.
 * Специфика конкретного сайта (домен картинок, разметка описания)
 * вынесена в подключаемые стратегии (ImageExtractor, extractDescription),
 * поэтому новый похожий источник добавляется конфигом, а не новым классом.
 */
export class RssSourceAdapter implements SourceAdapter {
  readonly sourceId: string;
  private readonly parser: Parser<unknown>;

  constructor(private readonly options: RssSourceAdapterOptions) {
    this.sourceId = options.sourceId;
    this.parser = new Parser();
  }

  async fetch(): Promise<FeedEntry[]> {
    const xml = await fetchText(
      this.options.url,
      this.options.timeoutMs,
      this.options.userAgent
    );

    const feed = await this.parser.parseString(xml);
    const entries: FeedEntry[] = [];

    for (const item of feed.items as AtomItem[]) {
      const entry = this.toFeedEntry(item);

      if (entry) {
        entries.push(entry);
      }
    }

    return entries;
  }

  private toFeedEntry(item: AtomItem): FeedEntry | null {
    // Atom использует <id>, RSS/RDF (как LOR) — <guid>.
    const rawId = item.guid?.trim() ?? item.id?.trim();
    const title = item.title?.trim();
    const link = item.link?.trim();

    if (!rawId || !title || !link) {
      return null;
    }

    const imageUrls = this.options.imageExtractor.extract(item);

    if (this.options.requireImages && imageUrls.length === 0) {
      return null;
    }

    const content = this.options.extractDescription
      ? normalizeText(this.options.extractDescription(item))
      : normalizeText(itemHtmlContent(item) || item.description || '');

    if (this.options.requireImages && !content && imageUrls.length === 0) {
      return null;
    }

    const published = itemPublished(item);
    const updated = itemUpdated(item, published);

    return {
      id: `${this.sourceId}:${rawId}`,
      sourceId: this.sourceId,
      title,
      link,
      author: getAuthor(item.author, item.creator),
      content,
      published,
      updated,
      imageUrls
    };
  }
}
