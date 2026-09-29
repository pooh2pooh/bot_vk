import { BoundedCache } from './bounded-cache.js';
import { fetchText } from './text-utils.js';
import type { AtomItem } from './atom-item.js';
import type { ImageExtractor } from './image-extractor.js';

/**
 * Загрузка HTML страницы поста. Вынесена в тип, чтобы её можно было подменить
 * в тестах — сеть в тестах не нужна.
 */
export type PageFetcher = (
  url: string,
  timeoutMs: number,
  userAgent: string
) => Promise<string>;

export interface PageBasedExtractorOptions {
  baseUrl?: string;
  userAgent?: string;
  requestTimeoutMs?: number;
  /** Сколько разобранных страниц держать в памяти. */
  pageCacheSize?: number;
  fetchPage?: PageFetcher;
}

/** Значения, которые подставляет экстрактор, если их не передали явно. */
export type PageBasedExtractorDefaults = Required<
  Omit<PageBasedExtractorOptions, 'fetchPage'>
>;

/**
 * Общая часть всех экстракторов, которые догружают страницу поста.
 *
 * Забирает на себя то, что иначе дублировалось бы в каждом экстракторе:
 * параметры запроса, кеш разобранных страниц и слияние картинок из фида и со
 * страницы. Конкретный сайт добавляет только `parse`-функцию: что и как
 * искать в разметке.
 *
 * Параметр `TPage` — результат разбора страницы. У LOR это просто список
 * URL картинок, у pingvinus — пара «картинки + текст поста».
 */
export abstract class PageBasedImageExtractor<TPage> implements ImageExtractor {
  abstract extract(item: AtomItem): Promise<string[]>;

  protected readonly baseUrl: string;
  protected readonly userAgent: string;
  protected readonly requestTimeoutMs: number;

  private readonly fetchPage: PageFetcher;

  /**
   * Кеш разобранных страниц. Заполнение фида вызывает extract() для КАЖДОГО
   * элемента на КАЖДОМ опросе, а посты не меняются после публикации — без кеша
   * это давало бы лишний HTTP-запрос на каждый элемент на каждом цикле.
   * Кешируется и пустой результат тоже, иначе посты с одной картинкой
   * перезапрашивались бы бесконечно.
   */
  private readonly pages: BoundedCache<TPage>;

  protected constructor(
    defaults: PageBasedExtractorDefaults,
    options: PageBasedExtractorOptions = {}
  ) {
    this.baseUrl = options.baseUrl ?? defaults.baseUrl;
    this.userAgent = options.userAgent ?? defaults.userAgent;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? defaults.requestTimeoutMs;
    this.fetchPage =
      options.fetchPage ??
      ((url, timeoutMs, userAgent) => fetchText(url, timeoutMs, userAgent));
    this.pages = new BoundedCache<TPage>(
      options.pageCacheSize ?? defaults.pageCacheSize
    );
  }

  /**
   * Загружает страницу поста и разбирает её ОДИН раз за процесс.
   *
   * Ошибки загрузки наружу не пробрасываются: вызывающий код решает, что
   * лучше — отдать то, что есть из фида, или вообще не отправлять пост.
   */
  protected async loadPage(
    url: string,
    parse: (html: string) => TPage
  ): Promise<TPage> {
    const cached = this.pages.get(url);

    if (cached !== undefined) {
      return cached;
    }

    const html = await this.fetchPage(url, this.requestTimeoutMs, this.userAgent);
    const page = parse(html);

    this.pages.set(url, page);

    return page;
  }

  /**
   * Картинки со страницы идут после картинок из фида, дубликаты убираются.
   * Если со страницы ничего не достали, остаётся то, что было в фиде.
   */
  protected mergeImages(
    fromFeed: string[],
    fromPage: string[]
  ): string[] {
    if (fromPage.length === 0) {
      return fromFeed;
    }

    return [...new Set([...fromFeed, ...fromPage])];
  }
}
