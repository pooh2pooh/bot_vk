import Parser from 'rss-parser';

import type { DescriptionExtractor } from '../core/description-extractor.js';
import type { ImageExtractor } from '../core/image-extractor.js';
import type {
  FetchOptions,
  SourceAdapter
} from '../core/source-adapter.js';
import type { FeedEntry } from '../core/types.js';
import type { AtomItem } from '../core/atom-item.js';
import {
  fetchText,
  getAuthor,
  itemPublished,
  itemUpdated,
  normalizeText
} from '../core/text-utils.js';

export interface RssSourceAdapterOptions {
  sourceId: string;
  url: string;
  timeoutMs: number;
  userAgent: string;
  imageExtractor: ImageExtractor;
  /** Если true — записи без картинок отбрасываются (напр. "скриншотные" источники). */
  requireImages: boolean;
  /**
   * Экстрактор текста описания. Реализацию по умолчанию (обычная нормализация
   * HTML) даёт DescriptionExtractorRegistry под ключом `none`, а источники
   * вроде LOR подключают свою, которая дополнительно вырезает из описания
   * блоки картинок и теги.
   */
  extractDescription: DescriptionExtractor;
  /**
   * Если задан, в источник попадают только записи, чей link совпал с этим
   * шаблоном. Нужен сайтам, у которых один фид на все рубрики: чтобы в
   * «скриншоты» не попадали новости, а в источник — заметки.
   */
  includePattern?: RegExp;
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

  async fetch(options: FetchOptions = {}): Promise<FeedEntry[]> {
    const xml = await fetchText(
      this.options.url,
      this.options.timeoutMs,
      this.options.userAgent
    );

    const feed = await this.parser.parseString(xml);
    const entries: FeedEntry[] = [];

    for (const item of feed.items as AtomItem[]) {
      /*
       * Оба фильтра применяются ДО экстракции картинок: отброшенная запись
       * не должна ни ходить на страницу поста, ни платить за это запросом.
       * Для pingvinus это важно — в фиде смешаны новости, заметки и
       * скриншоты, и страницы надо открывать только у последних.
       */
      if (this.options.includePattern && !this.matchesInclude(item)) {
        continue;
      }

      const entry = await this.toFeedEntry(item, options.skipIds);

      if (entry) {
        entries.push(entry);
      }
    }

    return entries;
  }

  private matchesInclude(item: AtomItem): boolean {
    const pattern = this.options.includePattern;

    if (!pattern) {
      return true;
    }

    // guid у pingvinus — "5532 at https://pingvinus.ru", это не ссылка на
    // пост, поэтому ориентируемся на link, а guid берём лишь как запасной
    // вариант для фидов без <link>.
    const candidates = [item.link, item.guid];

    return candidates.some(
      value => typeof value === 'string' && pattern.test(value.trim())
    );
  }

  /**
   * Переизвлекает картинки конкретной записи.
   *
   * Сначала пробуем свежий фид — это самый дешёвый путь. Но записи в базе
   * бывают старше окна фида (RSS отдаёт только последние ~30 постов), и для
   * resend такой пост в фиде просто отсутствует. Поэтому, если в фиде его не
   * нашлось, идём на страницу поста напрямую: там картинки лежат всегда.
   *
   * Если не сработало ни то, ни другое — null, и вызывающий код остаётся на
   * сохранённом значении, а не отправляет пост без картинок.
   */
  async reextractImages(id: string, link?: string): Promise<string[] | null> {
    // Без skipIds: цель — НАЙТИ запись в фиде, а не отбросить обработанные.
    const entries = await this.fetch();
    const match = entries.find(entry => entry.id === id);

    if (match) {
      return match.imageUrls;
    }

    if (!link) {
      return null;
    }

    const extractFromUrl = this.options.imageExtractor.extractFromUrl;

    if (!extractFromUrl) {
      return null;
    }

    const fromPage = await extractFromUrl.call(this.options.imageExtractor, link);

    return fromPage.length > 0 ? fromPage : null;
  }

  private async toFeedEntry(
    item: AtomItem,
    skipIds?: ReadonlySet<string>
  ): Promise<FeedEntry | null> {
    // Atom использует <id>, RSS/RDF (как LOR) — <guid>.
    const rawId = item.guid?.trim() ?? item.id?.trim();
    const title = item.title?.trim();
    const link = item.link?.trim();

    if (!rawId || !title || !link) {
      return null;
    }

    const id = `${this.sourceId}:${rawId}`;

    if (skipIds?.has(id)) {
      return null;
    }

    const imageUrls = await this.options.imageExtractor.extract(item);

    if (this.options.requireImages && imageUrls.length === 0) {
      return null;
    }

    const content = normalizeText(this.options.extractDescription(item));

    const published = itemPublished(item);
    const updated = itemUpdated(item, published);

    return {
      id,
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
