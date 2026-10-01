import { BoundedCache } from './bounded-cache.js';
import { fetchText, type HttpOptions } from './http.js';
import type { FeedItem } from './feed-item.js';
import type { SiteStrategy } from './site-strategy.js';

/**
 * Загрузка страницы поста. Вынесена в тип, чтобы её можно было подменить в
 * тестах: сеть в тестах не нужна.
 */
export type PageLoader = (
  url: string,
  options: HttpOptions
) => Promise<string>;

/** Что источник даёт стратегии для загрузки страниц постов. */
export interface PageContext extends HttpOptions {
  /**
   * Сколько разобранных страниц держать в памяти.
   *
   * Посты не меняются после публикации, поэтому разбирать страницу второй раз
   * незачем, а держать бесконечно много разобранного HTML нельзя.
   */
  pageCacheSize: number;

  /**
   * Максимум одновременных загрузок страниц.
   *
   * Без потолка сборка новых постов шла строго последовательно: тридцать постов
   * означали тридцать последовательных задержек сети, и время опроса росло
   * вместе с количеством новых постов. С потолком страницы качаются пачками.
   */
  maxParallelPages: number;
}

/**
 * База для стратегий, которым нужно догружать страницу поста.
 *
 * Забирает на себя общее для всех таких сайтов: таймаут и User-Agent, потолок
 * параллельных загрузок, кеш разобранных страниц и слияние картинок из фида и
 * со страницы. Сайт добавляет только `parse`: какой блок разметки искать.
 *
 * `TPage` — результат разбора страницы. У LOR это просто список URL картинок,
 * у pingvinus — пара «картинки + текст поста».
 */
export abstract class PageBasedSite<TPage> implements SiteStrategy {
  protected readonly ctx: PageContext;

  /** Картинки из элемента фида; при необходимости с догрузкой со страницы. */
  abstract images(item: FeedItem): Promise<string[]>;

  /** Описание из элемента фида, сырая разметка. */
  abstract description(item: FeedItem): string;

  private readonly pages: BoundedCache<TPage>;

  /** Загрузки страниц, идущие прямо сейчас — для ограничения параллелизма. */
  private inFlight = 0;

  /** Очередь страниц, ждущих свободного слота. */
  private waiting: Array<() => void> = [];

  protected constructor(
    ctx: PageContext,
    /** Адрес сайта: относительные ссылки резолвятся относительно него. */
    protected readonly baseUrl: string,
    loadPage: PageLoader = fetchText
  ) {
    this.ctx = ctx;
    this.pages = new BoundedCache(ctx.pageCacheSize);
    this.loadPage = loadPage;
  }

  private readonly loadPage: PageLoader;

  /**
   * Страница поста, разобранная ОДИН раз за процесс.
   *
   * Ошибки загрузки наружу не пробрасываются: вызывающий код решает, что
   * лучше — отдать то, что есть из фида, или вообще не отправлять пост.
   *
   * Пустой результат кешируется тоже, иначе посты без нужной разметки
   * запрашивались бы заново на каждом цикле.
   */
  protected async page(
    url: string,
    parse: (html: string) => TPage
  ): Promise<TPage> {
    const cached = this.pages.get(url);

    if (cached !== undefined) {
      return cached;
    }

    const parsed = parse(await this.limit(() => this.loadPage(url, this.ctx)));

    this.pages.set(url, parsed);

    return parsed;
  }

  /**
   * Карусель вместо очереди ожидания.
   *
   * Слот освобождается в finally, поэтому зависший запрос не блокирует источник
   * навсегда: у загрузки есть собственный таймаут в `core/http.ts`.
   */
  private async limit<T>(task: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.ctx.maxParallelPages) {
      await new Promise<void>(resolve => this.waiting.push(resolve));
    }

    this.inFlight++;

    try {
      return await task();
    } finally {
      this.inFlight--;
      this.waiting.shift()?.();
    }
  }

  /**
   * Картинки со страницы идут после картинок из фида, дубликаты убираются.
   * Если со страницы ничего не достали, остаётся то, что было в фиде.
   */
  protected mergeImages(fromFeed: string[], fromPage: string[]): string[] {
    if (fromPage.length === 0) {
      return fromFeed;
    }

    return [...new Set([...fromFeed, ...fromPage])];
  }
}