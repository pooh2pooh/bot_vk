import he from 'he';

import type { FeedItem } from '../../core/feed-item.js';
import { itemHtmlContent, itemLink } from '../../core/feed-item.js';
import {
  balancedElement,
  findElementByClass
} from '../../core/html.js';
import { createImageUrlMatcher } from '../../core/image-url.js';
import {
  PageBasedSite,
  type PageContext,
  type PageLoader
} from '../../core/page-based-site.js';

/**
 * Кандидат в картинку поста с оценкой качества.
 *
 * `order` — позиция в разметке: она решает исходы между равными по качеству
 * вариантами, чтобы в сообщение попадала та картинка, которую автор поставил
 * первой, а не любая понравившаяся регулярке.
 */
interface ImageCandidate {
  url: string;
  /** Ширина по имени файла или из srcset. */
  width: number;
  /** Приоритет источника: именованный вариант важнее угаданного. */
  priority: number;
  order: number;
}

/** Картинки сайта лежат только в этих каталогах — всё остальное это иконки. */
const LOR_IMAGE_PATH = /^\/(?:images|photos)\/.*\.(?:png|jpe?g|webp|gif|avif)$/i;

const SITE_URL = 'https://www.linux.org.ru';

const LOR_URL = createImageUrlMatcher({
  baseUrl: SITE_URL,
  hostnames: ['linux.org.ru', 'www.linux.org.ru'],
  pathPattern: LOR_IMAGE_PATH
});

/** Пост галереи: /gallery/screenshots/18389326, /gallery/workplaces/123 и т.п. */
const GALLERY_POST = /\/gallery\/[\w-]+\/\d+\/?$/;

/**
 * Имя файла разбора одного варианта одной картинки.
 *
 * LOR отдаёт набор `500px.jpg, 1000px.jpg, 1500px.jpg, 2000px.jpg`, а иногда
 * `original.jpg` / `full.jpg` / `master.jpg`. Подставлять выдуманный
 * `/original.jpg` нельзя — его может не быть. Поэтому варианты группируются
 * по каталогу, и в сообщение идёт лучший РЕАЛЬНО найденный.
 */
function candidateInfo(url: string, order: number): ImageCandidate {
  const filename = new URL(url).pathname.split('/').pop() ?? '';
  const sized = /^(\d{2,5})px\./i.exec(filename);

  if (sized) {
    return { url, width: Number(sized[1]), priority: 0, order };
  }

  const named = /^(?:original|orig|full|master|large)\./i.test(filename);

  return { url, width: 0, priority: named ? 10 : 1, order };
}

/** Каталог файла: все варианты одной картинки лежат рядом. */
function groupKey(url: string): string {
  try {
    const { origin, pathname } = new URL(url);
    const cut = pathname.lastIndexOf('/') + 1;

    return `${origin}${pathname.slice(0, cut)}`;
  } catch {
    return url;
  }
}

/**
 * Достаёт со страницы только блок галереи.
 *
 * Если разметка изменилась и маркера нет — берётся вся страница: фильтр по
 * домену и пути всё равно отсечёт всё постороннее, а вот потерять все
 * картинки поста из-за незнакомого класса контейнера нельзя.
 */
function galleryMarkup(html: string): string {
  const start = findElementByClass(html, 'slider-container');

  return start === -1 ? html : balancedElement(html, start);
}

/**
 * linux.org.ru.
 *
 * RSS кладёт в описание только ПЕРВУЮ картинку галереи, хотя пост может
 * состоять из десятка скриншотов. Поэтому стратегия идёт на страницу поста за
 * остальными — но только для постов галереи: у обычных тем фида разбирать
 * нечего, и лишние запросы просто нагружают сайт.
 */
export class LorSite extends PageBasedSite<string[]> {
  constructor(ctx: PageContext, loadPage?: PageLoader) {
    super(ctx, SITE_URL, loadPage);
  }

  async images(item: FeedItem): Promise<string[]> {
    const fromFeed = collectImages(itemHtmlContent(item));
    const link = itemLink(item);

    if (!link || !GALLERY_POST.test(link)) {
      return fromFeed;
    }

    try {
      const fromPage = await this.page(link, galleryImages);

      return this.mergeImages(fromFeed, fromPage);
    } catch (error) {
      /*
       * Из фида хоть что-то есть — отдаём что есть: потеря одной картинки
       * лучше потери поста целиком. Если не было ничего, глушить ошибку
       * нельзя: адаптер выбросит запись по правилу requireImages, и пост
       * молча исчез бы навсегда. Пробрасываем — внешний backoff перепроверит
       * источник на следующем цикле.
       */
      if (fromFeed.length > 0) {
        return fromFeed;
      }

      throw error;
    }
  }

  /**
   * Описание из фида: выкидываем картинки и строку с тегами.
   *
   * Возвращается разметка, а не текст: разбор в текст делает адаптер, в одном
   * месте для всех источников. Если раскрыть HTML здесь, адаптер раскроет его
   * второй раз, и куски, где автор писал «&lt;b&gt;» буквально, исчезли бы
   * вместе с настоящими тегами.
   */
  description(item: FeedItem): string {
    return itemHtmlContent(item)
      .replace(
        /<div\b[^>]*class\s*=\s*["'][^"']*\bmedium-image-container\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
        ''
      )
      .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '')
      .replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, '')
      .replace(/<img\b[^>]*>/gi, '')
      .replace(/<source\b[^>]*>/gi, '')
      .replace(
        /<p\b[^>]*class\s*=\s*["'][^"']*\btags\b[^"']*["'][^>]*>[\s\S]*?<\/p>/gi,
        ''
      );
  }

  /**
   * Картинки по прямой ссылке — путь для resend.
   *
   * Записи в базе могут быть старше окна фида, и тогда перечитывать фид
   * бесполезно: поста в нём просто нет. Страница доступна всегда.
   */
  async imagesFromUrl(url: string): Promise<string[]> {
    if (!GALLERY_POST.test(url)) {
      return [];
    }

    try {
      return await this.page(url, galleryImages);
    } catch {
      return [];
    }
  }
}

function galleryImages(html: string): string[] {
  return collectImages(galleryMarkup(html));
}

/**
 * Общий разбор разметки LOR — и фида, и страницы поста.
 *
 * Три источника URL по очереди, потому что разметка меняется от поста к посту:
 * обычные атрибуты, responsive-варианты и иногда голый URL текстом.
 */
function collectImages(markup: string): string[] {
  const source = he.decode(markup);
  const candidates: ImageCandidate[] = [];

  const add = (value: string, widthHint?: number): void => {
    const url = LOR_URL(value);

    if (!url) {
      return;
    }

    const candidate = candidateInfo(url, candidates.length);

    if (widthHint && candidate.width === 0) {
      candidate.width = widthHint;
    }

    candidates.push(candidate);
  };

  for (const match of source.matchAll(
    /<(?:a|img|source|picture)\b[^>]*\b(?:href|src|data-src|data-original|data-full|data-url)\s*=\s*["']([^"']+)["'][^>]*>/gi
  )) {
    if (match[1]) {
      add(match[1]);
    }
  }

  for (const match of source.matchAll(
    /\b(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi
  )) {
    if (match[1]) {
      addSrcset(match[1], add);
    }
  }

  /*
   * Иногда LOR оставляет URL картинки обычным текстом — абсолютным или
   * относительным.
   *
   * Хост здесь опционален, но lookbehind (?<![\w.-]) обязателен: без него
   * `https://evil.example.com/images/500px.jpg` находился бы как
   * `/images/500px.jpg`, резолвился относительно baseUrl и превращался в
   * несуществующий `https://linux.org.ru/images/500px.jpg` — молчаливая
   * подмена картинки вместо её отбрасывания.
   */
  for (const match of source.matchAll(
    /(?<![\w.-])(?:https?:\/\/(?:www\.)?linux\.org\.ru)?\/(?:images|photos)\/[^\s"'<>),]+\.(?:png|jpe?g|webp|gif|avif)/gi
  )) {
    add(match[0]);
  }

  return bestPerPicture(candidates);
}

/** `srcset="500.jpg 500w, 1000.jpg 1000w"` -> кандидаты с известной шириной. */
function addSrcset(
  value: string,
  add: (url: string, widthHint?: number) => void
): void {
  for (const chunk of value.split(',')) {
    const [url, descriptor] = chunk.trim().split(/\s+/);

    if (!url) {
      continue;
    }

    const width = descriptor?.match(/^(\d+)w$/i)?.[1];

    add(url, width ? Number(width) : undefined);
  }
}

/** По одной лучшей картинке на каталог, в порядке появления в разметке. */
function bestPerPicture(candidates: ImageCandidate[]): string[] {
  const groups = new Map<string, ImageCandidate[]>();

  for (const candidate of candidates) {
    const key = groupKey(candidate.url);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }

  return [...groups.values()]
    .sort(
      (a, b) => Math.min(...a.map(x => x.order)) - Math.min(...b.map(x => x.order))
    )
    .map(list => {
      const best = [...list].sort(
        (a, b) => b.priority - a.priority || b.width - a.width || a.order - b.order
      )[0];

      return best?.url ?? '';
    })
    .filter(Boolean);
}
