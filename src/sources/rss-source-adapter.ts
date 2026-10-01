import Parser from 'rss-parser';
import { fetchText, type HttpOptions } from '../core/http.js';
import {
  itemEntryId,
  toFeedEntry,
  type FeedItem
} from '../core/feed-item.js';
import type { FeedEntry } from '../core/types.js';
import type { FetchOptions, SourceAdapter } from '../core/source-adapter.js';
import type { SiteStrategy } from '../core/site-strategy.js';
import type { Filter } from '../core/filter.js';

/** Настройки проверки одного RSS/Atom-источника. */
export interface RssSourceOptions extends HttpOptions {
  /** Ключ источника из config/sources.yml: он же префикс id записей. */
  sourceId: string;

  /** Адрес фида. */
  feedUrl: string;

  /**
   * Показывать запись, только если заголовок подходит под фильтр.
   *
   * Пусто — показывать всё. Нужен сайтам, где в один фид свалены разные
   * разделы: у manjaro.ru так отдаются и анонсы обновлений, и обычные
   * новости, а нужны только анонсы.
   */
  includeFilter?: Filter;

  /**
   * Бросать запись без картинок.
   *
   * Источники новостей несут в основном текст и ждут в ленту, а источники
   * скриншотов и релизов без картинки бессмысленны. Решение принимает
   * конфигурация источника, а не код стратегии: стратегия обязана лишь
   * вернуть то, что у неё есть.
   */
  requireImages: boolean;

  /** Стратегия сайта: как достать картинки и текст поста. */
  strategy: SiteStrategy;

  /**
   * Куда сообщить, что разбор конкретной записи не удался.
   *
   * Молча проглатывать такие ошибки нельзя: иначе сломанный разбор сайта
   * выглядит как «источник просто не принёс новых постов» и обнаруживается
   * через месяц. Заголовок источника добавляет вызывающий код.
   */
  onStrategyError?: (error: unknown) => void;
}

/**
 * Адаптер RSS/Atom — единственная реализация для всех сайтов на фидах.
 *
 * Разница между источниками целиком в `SiteStrategy`, `includeFilter` и
 * `requireImages`: этот класс не знает ни про один сайт и одинаково работает
 * с RSS 2.0, RDF и Atom, потому что различия снимает парсер.
 */
export class RssSourceAdapter implements SourceAdapter {
  readonly sourceId: string;

  private readonly parser = new Parser();

  constructor(private readonly options: RssSourceOptions) {
    this.sourceId = options.sourceId;
  }

  /**
   * Забирает фид и превращает его в записи конвейера.
   *
   * Разбор записей не зависит друг от друга, поэтому картинки достаются
   * пачками (потолок задаёт стратегия через PageContext.maxParallelPages):
   * тридцать постов больше не означают тридцать последовательных задержек
   * сети. Порядок записей при этом сохраняется.
   */
  async fetch(options?: FetchOptions): Promise<FeedEntry[]> {
    const { skipIds } = options ?? {};
    const items = await this.load();

    const resolved = await Promise.all(
      items.map(item => this.resolve(item, skipIds))
    );

    return resolved.filter((entry): entry is FeedEntry => entry !== null);
  }

  async imagesForPost(link: string): Promise<string[]> {
    return this.options.strategy.imagesFromUrl?.(link) ?? [];
  }

  async postText(link: string): Promise<string> {
    return this.options.strategy.postText?.(link) ?? '';
  }

  /** Загрузка и разбор фида. Ошибка пробрасывается: без фида источника нет. */
  private async load(): Promise<FeedItem[]> {
    const { feedUrl, timeoutMs, userAgent } = this.options;
    const xml = await fetchText(feedUrl, { timeoutMs, userAgent });
    const feed = await this.parser.parseString(xml);

    return feed.items as FeedItem[];
  }

  /**
   * Запись → запись конвейера либо null, если в сообщение её нечего слать.
   *
   * null — это штатный исход, а не ошибка: так отсеиваются чужие разделы
   * фида, уже обработанные посты и записи без обязательной картинки.
   */
  private async resolve(
    item: FeedItem,
    skipIds?: ReadonlySet<string>
  ): Promise<FeedEntry | null> {
    const { includeFilter, requireImages, strategy } = this.options;

    // Уже обработанные и не проходящие фильтр записи отбрасываются ДО
    // извлечения картинок: у части стратегий это ходит на страницу поста, и
    // без раннего выхода каждый опрос оплачивал бы десятки лишних HTTP-запросов
    // к чужому сайту ради постов, которые конвейер всё равно отбросил бы.
    if (skipIds?.has(itemEntryId(this.sourceId, item) ?? '')) {
      return null;
    }

    if (includeFilter && !includeFilter.matches(item.title ?? '')) {
      return null;
    }

    let images: string[] = [];

    try {
      images = await strategy.images(item);
    } catch (error) {
      // Ошибка разбора не должна ронять весь опрос источника. То, что
      // удалось вытащить, отдаётся как есть; если не вышло ничего — запись
      // уйдёт в null по правилу requireImages.
      images = [];

      this.options.onStrategyError?.(error);
    }

    return toFeedEntry(this.sourceId, item, {
      images,
      description: strategy.description(item),
      requireImages
    });
  }
}