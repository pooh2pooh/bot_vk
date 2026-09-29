import he from 'he';

import type { AtomItem } from '../../core/atom-item.js';
import {
  balancedElement,
  findElementByClass
} from '../../core/html-blocks.js';
import {
  PageBasedImageExtractor,
  type PageBasedExtractorOptions
} from '../../core/page-based-extractor.js';
import { itemHtmlContent } from '../../core/text-utils.js';

const { decode } = he;

interface ImageCandidate {
  url: string;
  width: number;
  priority: number;
  order: number;
}

export type { PageFetcher } from '../../core/page-based-extractor.js';

export interface LorImageExtractorOptions
  extends PageBasedExtractorOptions {
  /**
   * Догружать ли остальные картинки со страницы.
   *
   * RSS linux.org.ru кладёт в описание только ПЕРВУЮ картинку галереи, а сам
   * пост может состоять из нескольких скриншотов. Выключать это стоит только
   * если некуда ходить за страницей поста.
   */
  fetchPageImages?: boolean;
}

const DEFAULTS = {
  baseUrl: 'https://www.linux.org.ru',
  userAgent: 'VK-Feed-Bot/2.0',
  requestTimeoutMs: 30_000,
  fetchPageImages: true,
  pageCacheSize: 500
} as const;

/** Пост галереи: /gallery/screenshots/18389326, /gallery/workplaces/123 и т.п. */
const GALLERY_LINK_PATTERN = /\/gallery\/[\w-]+\/\d+\/?$/;

function normalizeUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(
      decode(value)
        .replace(/&amp;/gi, '&')
        .replace(/^['"]|['"]$/g, '')
        .trim(),
      baseUrl
    );

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'linux.org.ru' && hostname !== 'www.linux.org.ru') {
      return null;
    }

    const pathname = decodeURIComponent(url.pathname);
    if (!/^\/(?:images|photos)\//i.test(pathname)) {
      return null;
    }

    if (!/\.(?:png|jpe?g|webp|gif|avif)$/i.test(pathname)) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function getCandidateInfo(url: string, order: number): ImageCandidate {
  const pathname = new URL(url).pathname;
  const filename = pathname.split('/').pop() ?? '';
  const widthMatch = filename.match(/^(\d{2,5})px\.(?:png|jpe?g|webp|gif|avif)$/i);

  if (widthMatch) {
    return {
      url,
      width: Number(widthMatch[1]),
      priority: 0,
      order
    };
  }

  const namedVariant = filename.match(
    /^(original|orig|full|master|large)\.(?:png|jpe?g|webp|gif|avif)$/i
  );

  return {
    url,
    width: 0,
    priority: namedVariant ? 10 : 1,
    order
  };
}

/**
 * Одна и та же картинка на LOR может быть представлена как:
 *   500px.jpg, 1000px.jpg, 1500px.jpg, 2000px.jpg
 * или как original/full/master и т.п.
 *
 * Не подменяем URL на выдуманный /original.jpg — его может вообще не быть.
 * Вместо этого группируем варианты одной директории и выбираем самый
 * качественный реально найденный URL.
 */
function groupKey(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const directory = pathname.slice(0, pathname.lastIndexOf('/') + 1);
    return `${parsed.origin}${directory}`;
  } catch {
    return url;
  }
}

function parseSrcset(
  value: string,
  baseUrl: string,
  add: (url: string, widthHint?: number) => void
): void {
  for (const chunk of value.split(',')) {
    const parts = chunk.trim().split(/\s+/);
    if (!parts[0]) {
      continue;
    }

    const width = parts[1]?.match(/^(\d+)w$/i)?.[1];
    const normalized = normalizeUrl(parts[0], baseUrl);
    if (normalized) {
      add(normalized, width ? Number(width) : undefined);
    }
  }
}

/**
 * Достаёт со страницы только блок галереи, а если разметка изменилась и
 * маркера нет — всю страницу: фильтр по домену и пути всё равно отсечёт
 * всё постороннее.
 */
function galleryMarkup(html: string): string {
  const start = findElementByClass(html, 'slider-container');
  return start === -1 ? html : balancedElement(html, start);
}

/** Убирает изображения, preview-блоки и строку с тегами из описания LOR-поста. */
export function extractLorDescription(item: AtomItem): string {
  return decode(itemHtmlContent(item))
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

export class LorImageExtractor extends PageBasedImageExtractor<string[]> {
  private readonly fetchPageImages: boolean;

  constructor(options: LorImageExtractorOptions = {}) {
    super(DEFAULTS, options);
    this.fetchPageImages = options.fetchPageImages ?? DEFAULTS.fetchPageImages;
  }

  async extract(item: AtomItem): Promise<string[]> {
    const fromFeed = this.collectImages(itemHtmlContent(item));

    if (!this.fetchPageImages) {
      return fromFeed;
    }

    const link = item.link?.trim() ?? item.guid?.trim();

    // За страницу ходим только за постами галереи: у обычных тем фида
    // разбирать нечего, а лишние запросы только нагружают сайт.
    if (!link || !GALLERY_LINK_PATTERN.test(link)) {
      return fromFeed;
    }

    try {
      const fromPage = await this.loadPageImages(link);
      return this.mergeImages(fromFeed, fromPage);
    } catch (error) {
      /*
       * Если из фида хоть что-то есть — отправляем что есть: потеря одной
       * картинки лучше, чем потеря поста целиком.
       *
       * Если из фида не было ничего (requireSources с requireImages выбросил
       * бы запись), то глушить ошибку нельзя: пост молча исчез бы навсегда.
       * Пробрасываем — внешний backoff перепроверит на следующем цикле.
       */
      if (fromFeed.length > 0) {
        return fromFeed;
      }

      throw error;
    }
  }

  /**
   * Достаёт все картинки поста по прямой ссылке, без участия фида.
   *
   * Путь для resend: записи в баке старше текущего окна фида, поэтому
   * перечитывать фид бесполезно — поста в нём просто нет. Страница поста
   * доступна всегда, и на ней лежат все слайды галереи.
   *
   * Если страница не галерейная или разобрать её не вышло — возвращает
   * пустой массив, и вызывающий код остаётся на сохранённом значении.
   */
  async extractFromUrl(url: string): Promise<string[]> {
    if (!this.fetchPageImages || !GALLERY_LINK_PATTERN.test(url)) {
      return [];
    }

    try {
      return await this.loadPageImages(url);
    } catch {
      return [];
    }
  }

  private loadPageImages(url: string): Promise<string[]> {
    return this.loadPage(url, html => this.collectImages(galleryMarkup(html)));
  }

  /**
   * Общий разбор разметки: собирает все подходящие URL, схлопывает варианты
   * одной картинки и возвращает по одному лучшему URL на картинку.
   * Используется и для описания из фида, и для HTML страницы поста.
   */
  private collectImages(markup: string): string[] {
    const source = decode(markup);
    const candidates: ImageCandidate[] = [];
    let order = 0;

    const add = (value: string, widthHint?: number): void => {
      const normalized = normalizeUrl(value, this.baseUrl);
      if (!normalized) {
        return;
      }

      const candidate = getCandidateInfo(normalized, order++);
      if (widthHint && candidate.width === 0) {
        candidate.width = widthHint;
      }
      candidates.push(candidate);
    };

    // href/src/data-* у ссылок, img и source.
    const attributeRegex =
      /<(?:a|img|source|picture)\b[^>]*\b(?:href|src|data-src|data-original|data-full|data-url)\s*=\s*["']([^"']+)["'][^>]*>/gi;

    for (const match of source.matchAll(attributeRegex)) {
      if (match[1]) {
        add(match[1]);
      }
    }

    // Responsive images: srcset="...500w, ...1000w, ...1500w".
    const srcsetRegex =
      /\b(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi;

    for (const match of source.matchAll(srcsetRegex)) {
      if (match[1]) {
        parseSrcset(match[1], this.baseUrl, add);
      }
    }

    // Иногда LOR оставляет URL картинки обычным текстом в HTML — как
    // абсолютный (https://linux.org.ru/images/...), так и относительный
    // (/images/...).
    //
    // Хост здесь опционален, но lookbehind (?<![\w.-]) обязателен: он не даёт
    // регулярке начать матч с середины ЧУЖОГО URL. Без него
    // `https://evil.example.com/images/500px.jpg` находился как
    // `/images/500px.jpg`, резолвился относительно baseUrl и превращался в
    // несуществующий `https://linux.org.ru/images/500px.jpg` — молчаливая
    // подмена картинки вместо её отбрасывания.
    const rawUrlRegex =
      /(?<![\w.-])(?:https?:\/\/(?:www\.)?linux\.org\.ru)?\/(?:images|photos)\/[^\s"'<>),]+\.(?:png|jpe?g|webp|gif|avif)/gi;

    for (const match of source.matchAll(rawUrlRegex)) {
      add(match[0]);
    }

    // Группируем варианты одной картинки и выбираем лучший реально найденный.
    const groups = new Map<string, ImageCandidate[]>();

    for (const candidate of candidates) {
      const key = groupKey(candidate.url);
      const list = groups.get(key) ?? [];
      list.push(candidate);
      groups.set(key, list);
    }

    return [...groups.values()]
      .sort((a, b) => Math.min(...a.map(x => x.order)) - Math.min(...b.map(x => x.order)))
      .map(list => {
        const best = [...list].sort(
          (a, b) =>
            b.priority - a.priority ||
            b.width - a.width ||
            a.order - b.order
        )[0];

        return best?.url ?? '';
      })
      .filter(Boolean);
  }
}
