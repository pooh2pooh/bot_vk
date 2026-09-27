import he from 'he';

import type { ImageExtractor } from '../../core/image-extractor.js';
import type { AtomItem } from '../atom-item.js';
import { itemHtmlContent } from '../text-utils.js';

const { decode } = he;

function normalizeUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(
      decode(value).replace(/&amp;/gi, '&').trim(),
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

    if (!pathname.startsWith('/images/')) {
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

/*
 * Превращаем любой thumbnail-вариант одной LOR-картинки в её canonical URL:
 *   500px.jpg / 1000px.jpg / 1500px.jpg / 2000px.jpg  ->  original.jpg
 * Благодаря этому одна картинка не попадёт во VK четыре раза.
 */
function canonicalImageUrl(url: string): string {
  try {
    const parsed = new URL(url);

    parsed.pathname = parsed.pathname.replace(
      /\/(?:500px|1000px|1500px|2000px)\.(png|jpe?g|webp|gif|avif)$/i,
      '/original.$1'
    );

    return parsed.href;
  } catch {
    return url;
  }
}

export class LorImageExtractor implements ImageExtractor {
  constructor(private readonly baseUrl = 'https://www.linux.org.ru') {}

  extract(item: AtomItem): string[] {
    const source = decode(itemHtmlContent(item));
    const urls = new Map<string, string>();

    /*
     * Приоритет: <a itemprop="contentURL" href=".../original.jpg">.
     * Это именно оригиналы изображений, а не preview.
     */
    const anchorRegex = /<a\b[^>]*>/gi;

    for (const match of source.matchAll(anchorRegex)) {
      const anchor = match[0];

      if (!/\bitemprop\s*=\s*["']contentURL["']/i.test(anchor)) {
        continue;
      }

      const href = anchor.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];

      if (!href) {
        continue;
      }

      const normalized = normalizeUrl(href, this.baseUrl);

      if (!normalized) {
        continue;
      }

      const canonical = canonicalImageUrl(normalized);
      urls.set(canonical, canonical);
    }

    /*
     * Fallback: если у картинки нет contentURL, берём src.
     * Это позволяет обработать RSS даже при изменении HTML-шаблона LOR.
     */
    const imageAttributeRegex =
      /<(?:img|source)\b[^>]*\b(?:src|data-src|data-original)\s*=\s*["']([^"']+)["'][^>]*>/gi;

    for (const match of source.matchAll(imageAttributeRegex)) {
      const normalized = normalizeUrl(match[1], this.baseUrl);

      if (!normalized) {
        continue;
      }

      const canonical = canonicalImageUrl(normalized);

      if (!urls.has(canonical)) {
        urls.set(canonical, canonical);
      }
    }

    return [...urls.values()];
  }
}

/** Убирает блоки картинок и строку с тегами из описания LOR-поста. */
export function extractLorDescription(item: AtomItem): string {
  const cleaned = decode(itemHtmlContent(item))
    .replace(
      /<div\b[^>]*class\s*=\s*["'][^"']*\bmedium-image-container\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
      ''
    )
    .replace(
      /<p\b[^>]*class\s*=\s*["'][^"']*\btags\b[^"']*["'][^>]*>[\s\S]*?<\/p>/gi,
      ''
    );

  return cleaned;
}
