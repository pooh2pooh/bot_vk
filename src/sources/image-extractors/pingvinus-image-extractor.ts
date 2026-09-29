import he from 'he';

import type { AtomItem } from '../../core/atom-item.js';
import {
  innerBlockByClass,
  postScope
} from '../../core/html-blocks.js';
import { itemHtmlContent } from '../../core/text-utils.js';
import {
  PageBasedImageExtractor,
  type PageBasedExtractorOptions,
  type PageFetcher
} from '../../core/page-based-extractor.js';

const { decode } = he;

export type { PageFetcher };

export interface PingvinusImageExtractorOptions
  extends PageBasedExtractorOptions {}

/** Что удаётся вытащить со страницы поста. */
interface PingvinusPage {
  imageUrls: string[];
  text: string;
}

const DEFAULTS = {
  baseUrl: 'https://pingvinus.ru',
  userAgent: 'VK-Feed-Bot/2.0',
  requestTimeoutMs: 30_000,
  pageCacheSize: 200
} as const;

/** Пост-скриншот: https://pingvinus.ru/gallery/5532 */
const GALLERY_LINK_PATTERN = /\/gallery\/\d+\/?$/;

/** Картинки сайта живут только тут — вне этого префикса это иконки и логотипы. */
const IMAGE_PATH_PATTERN = /^\/cr_images\/userpicture\/[ns]\/[^/]+\.(?:png|jpe?g|webp|gif)$/i;

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

    if (hostname !== 'pingvinus.ru' && hostname !== 'www.pingvinus.ru') {
      return null;
    }

    if (!IMAGE_PATH_PATTERN.test(decodeURIComponent(url.pathname))) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

/** Убирает из текста поста картинку и служебные блоки. */
export function extractPingvinusDescription(item: AtomItem): string {
  return decode(itemHtmlContent(item))
    .replace(/<div\b[^>]*class\s*=\s*["'][^"']*\bpictureThumb\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div\b[^>]*class\s*=\s*["'][^"']*\bextrelDistrGui\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<source\b[^>]*>/gi, '')
    .replace(/<p\b[^>]*>\s*<a\b[^>]*>[\s\S]*?<\/a>\s*<\/p>/gi, '');
}

/**
 * Достаёт текст поста со страницы.
 *
 * Нужен потому, что у pingvinus в RSS описание у постов-скриншотов ПУСТОЕ:
 * фид отдаёт только заголовок, весь текст живёт на странице. Без этого
 * fallback-текст (когда AI не ответил) был бы пустым.
 */
export function extractPingvinusPostText(html: string): string {
  const source = decode(html);

  const article = innerBlockByClass(postScope(source), 'text') ?? '';

  if (!article) {
    return '';
  }

  return decode(article)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    /*
     * Переносы ставим и по ОТКРЫВАЮЩИМ блочным тегам тоже. Иначе
     * "<h2>Предыстория</h2><p>Прошлый мой скриншот" склеится в
     * "ПредысторияПрошлый мой скриншот" — замена только закрывающих тегов
     * этого не спасает.
     */
    .replace(/<br\s*\/?>(?=\s*)/gi, '\n')
    .replace(
      /<\/?(?:p|div|h[1-6]|li|ul|ol|blockquote|section|article|table|tr|figure|figcaption)\b[^>]*>/gi,
      '\n'
    )
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class PingvinusImageExtractor extends PageBasedImageExtractor<PingvinusPage> {
  /**
   * Разбор страницы поста. Кешируется целиком: нужны сразу и картинка, и
   * текст — при отправке мы читаем страницу ради картинки, а при AI-fallback
   * ради текста, и ходить на один URL дважды незачем.
   */
  private readonly parsePage = (html: string): PingvinusPage => ({
    imageUrls: extractPingvinusPostImage(html, this.baseUrl),
    text: extractPingvinusPostText(html)
  });

  constructor(options: PingvinusImageExtractorOptions = {}) {
    super(DEFAULTS, options);
  }

  async extract(item: AtomItem): Promise<string[]> {
    const fromFeed = this.collectImages(itemHtmlContent(item));
    const link = item.link?.trim();

    if (!link || !GALLERY_LINK_PATTERN.test(link)) {
      return fromFeed;
    }

    try {
      const page = await this.loadPage(link, this.parsePage);
      return this.mergeImages(fromFeed, page.imageUrls);
    } catch {
      // Фид пуст у скриншотов, но на случай изменения разметки лучше отдать
      // хоть что-то из фида, чем потерять пост.
      return fromFeed;
    }
  }

  /**
   * Картинка поста — всегда одна, по разметке это <a> внутри .pictureThumb
   * со ссылкой на полную версию (превью лежит в t/, а в n/ — оригинал).
   *
   * Нужно resend'у: записи в базе могут быть старше окна фида, и тогда
   * перечитывать фид бесполезно — поста в нём просто нет.
   */
  async extractFromUrl(url: string): Promise<string[]> {
    if (!GALLERY_LINK_PATTERN.test(url)) {
      return [];
    }

    try {
      const page = await this.loadPage(url, this.parsePage);
      return page.imageUrls;
    } catch {
      return [];
    }
  }

  /**
   * Текст поста со страницы для fallback'а, когда AI-комментарий не удался.
   * Возвращает '' , если страница недоступна или разметка изменилась.
   */
  async extractTextFromUrl(url: string): Promise<string> {
    if (!GALLERY_LINK_PATTERN.test(url)) {
      return '';
    }

    try {
      const page = await this.loadPage(url, this.parsePage);
      return page.text;
    } catch {
      return '';
    }
  }

  private collectImages(markup: string): string[] {
    const source = decode(markup);
    const urls: string[] = [];

    const pattern =
      /\b(?:href|src|data-src)\s*=\s*["']([^"']+)["']/gi;

    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        const url = normalizeUrl(match[1], this.baseUrl);

        if (url) {
          urls.push(url);
        }
      }
    }

    return [...new Set(urls)];
  }
}

/**
 * Берёт картинку поста из блока .pictureThumb — и только её.
 *
 * Взять «все /cr_images/ со страницы» нельзя: там же лежат превью чужих
 * постов из сайдбара. Поэтому идём по контейнеру, а внутри него
 * предпочитаем ссылку на оригинал (n/) перед превью (t/).
 */
function extractPingvinusPostImage(
  html: string,
  baseUrl: string
): string[] {
  const block = innerBlockByClass(postScope(decode(html)), 'pictureThumb');

  if (!block) {
    return [];
  }

  const urls = [
    ...block.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi),
    ...block.matchAll(/\bsrc\s*=\s*["']([^"']+)["']/gi)
  ]
    .map(match => match[1] ?? '')
    .map(value => normalizeUrl(value, baseUrl))
    .filter((url): url is string => url !== null);

  // /n/ — оригинал, /t/ — превью. При равном приоритете оставляем порядок
  // из разметки: там href (оригинал) идёт раньше src (превью).
  return [...new Set(urls)].slice(0, 1);
}
