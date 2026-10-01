import he from 'he';

import type { FeedItem } from '../../core/feed-item.js';
import { itemHtmlContent, itemLink } from '../../core/feed-item.js';
import { innerBlockByClass, postScope } from '../../core/html.js';
import { createImageUrlMatcher, imagePath } from '../../core/image-url.js';
import {
  PageBasedSite,
  type PageContext,
  type PageLoader
} from '../../core/page-based-site.js';
import { stripDecodedMarkup } from '../../core/text.js';

/**
 * Всё, что нужно со страницы поста: и картинка, и текст.
 *
 * Обе величины разбираются ОДНИМ проходом и кешируются вместе. Иначе один и тот
 * же URL грузился бы дважды: при отправке ради картинки и при fallback-тексте
 * ради текста.
 */
interface PostPage {
  images: string[];
  text: string;
}

/**
 * Картинки постов лежат только в userpicture/n — это оригиналы.
 * Всё остальное (`/t/` — превью, сайдбар, аватары) в сообщение не годится.
 */
const SITE_URL = 'https://pingvinus.ru';

const PINGVINUS_URL = createImageUrlMatcher({
  baseUrl: SITE_URL,
  hostnames: ['pingvinus.ru', 'www.pingvinus.ru'],
  pathPattern: imagePath('/cr_images/userpicture/', 'n')
});

/** Пост-скриншот: https://pingvinus.ru/gallery/5532 */
const SCREENSHOT_POST = /\/gallery\/\d+\/?$/;

/**
 * pingvinus.ru.
 *
 * Особенность сайта: у постов-скриншотов в RSS описание ПУСТОЕ — фид отдаёт
 * только заголовок, весь текст живёт на странице. Поэтому стратегия обязана
 * уметь отдавать и текст со страницы: иначе при отказе AI в сообщение ушёл бы
 * один заголовок.
 */
export class PingvinusSite extends PageBasedSite<PostPage> {
  constructor(ctx: PageContext, loadPage?: PageLoader) {
    super(ctx, SITE_URL, loadPage);
  }

  async images(item: FeedItem): Promise<string[]> {
    const fromFeed = collectImages(itemHtmlContent(item));
    const link = itemLink(item);

    if (!link || !SCREENSHOT_POST.test(link)) {
      return fromFeed;
    }

    try {
      const page = await this.page(link, parsePost);

      return this.mergeImages(fromFeed, page.images);
    } catch {
      // Фид пуст у скриншотов, но на случай изменения разметки лучше отдать
      // хоть что-то из фида, чем потерять пост.
      return fromFeed;
    }
  }

  /**
   * Описание из фида: у pingvinus тут только служебная обвязка.
   *
   * Как и у всех стратегий, возвращается разметка: разбор в текст делает
   * адаптер, в одном месте для всех источников.
   */
  description(item: FeedItem): string {
    return itemHtmlContent(item)
      .replace(/<div\b[^>]*class\s*=\s*["'][^"']*\bpictureThumb\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
      .replace(/<div\b[^>]*class\s*=\s*["'][^"']*\bextrelDistrGui\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '')
      .replace(/<img\b[^>]*>/gi, '')
      .replace(/<source\b[^>]*>/gi, '')
      .replace(/<p\b[^>]*>\s*<a\b[^>]*>[\s\S]*?<\/a>\s*<\/p>/gi, '');
  }

  async imagesFromUrl(url: string): Promise<string[]> {
    if (!SCREENSHOT_POST.test(url)) {
      return [];
    }

    try {
      return (await this.page(url, parsePost)).images;
    } catch {
      return [];
    }
  }

  /**
   * Текст поста со страницы — fallback, когда генерация текста не удалась.
   * Пустая строка означает «взять нечего», и конвейер останется на том, что
   * есть в фиде.
   */
  async postText(url: string): Promise<string> {
    if (!SCREENSHOT_POST.test(url)) {
      return '';
    }

    try {
      return (await this.page(url, parsePost)).text;
    } catch {
      return '';
    }
  }
}

/** Разбор страницы поста: картинка из превью-блока и текст из `.text`. */
function parsePost(html: string): PostPage {
  const scoped = postScope(he.decode(html));

  return {
    images: postImage(scoped),
    text: postText(scoped)
  };
}

/**
 * Картинка поста — всегда одна, из блока `.pictureThumb`.
 *
 * Взять «все /cr_images/ со страницы» нельзя: там же лежат превью чужих постов
 * из сайдбара. Поэтому идём по контейнеру и берём первую подходящую ссылку —
 * в разметке это `href` на оригинал, `src` ведёт на превью.
 */
function postImage(scopedHtml: string): string[] {
  const block = innerBlockByClass(scopedHtml, 'pictureThumb');

  if (!block) {
    return [];
  }

  const found = [
    ...block.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi),
    ...block.matchAll(/\bsrc\s*=\s*["']([^"']+)["']/gi)
  ]
    .map(match => PINGVINUS_URL(match[1] ?? ''))
    .filter((url): url is string => url !== null);

  return [...new Set(found)].slice(0, 1);
}

function postText(scopedHtml: string): string {
  const article = innerBlockByClass(scopedHtml, 'text');

  return article ? stripDecodedMarkup(article) : '';
}

/** Картинки из описания фида — на случай, если фид снова начнёт их класть. */
function collectImages(markup: string): string[] {
  const found = [...he.decode(markup).matchAll(
    /\b(?:href|src|data-src)\s*=\s*["']([^"']+)["']/gi
  )]
    .map(match => PINGVINUS_URL(match[1] ?? ''))
    .filter((url): url is string => url !== null);

  return [...new Set(found)];
}