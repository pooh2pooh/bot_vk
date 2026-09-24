import Parser from 'rss-parser';
import he from 'he';

import type { FeedEntry } from '../types.js';
import {
  fetchText,
  normalizeText,
  type AtomItem
} from './reader.js';

const { decode } = he;

const LINUX_ORG_RU = 'https://www.linux.org.ru';

function normalizeUrl(
  value: string,
  baseUrl = LINUX_ORG_RU
): string | null {
  try {
    const url = new URL(
      decode(value)
        .replace(/&amp;/gi, '&')
        .trim(),
      baseUrl
    );

    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:'
    ) {
      return null;
    }

    const hostname = url.hostname.toLowerCase();

    if (
      hostname !== 'linux.org.ru' &&
      hostname !== 'www.linux.org.ru'
    ) {
      return null;
    }

    const pathname =
      decodeURIComponent(url.pathname);

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
 * Превращаем любой thumbnail-вариант одной LOR-картинки
 * в её canonical URL:
 *
 *   500px.jpg
 *   1000px.jpg
 *   1500px.jpg
 *   2000px.jpg
 *        ↓
 *   original.jpg
 *
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

function extractImageUrls(
  html: string
): string[] {
  const source = decode(html);
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

    const href = anchor.match(
      /\bhref\s*=\s*["']([^"']+)["']/i
    )?.[1];

    if (!href) {
      continue;
    }

    const normalized = normalizeUrl(href);

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
    const normalized = normalizeUrl(match[1]);

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

function extractDescription(
  html: string
): string {
  const cleaned = decode(html)
    // Убираем все блоки изображений вместе с их разметкой.
    .replace(
      /<div\b[^>]*class\s*=\s*["'][^"']*\bmedium-image-container\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
      ''
    )
    // Убираем строку с тегами.
    .replace(
      /<p\b[^>]*class\s*=\s*["'][^"']*\btags\b[^"']*["'][^>]*>[\s\S]*?<\/p>/gi,
      ''
    );

  return normalizeText(cleaned);
}

function getAuthor(
  author: AtomItem['author'],
  creator?: string
): string {
  if (typeof author === 'string') {
    return normalizeText(author) || 'Неизвестный автор';
  }

  if (author?.name) {
    return normalizeText(author.name) || 'Неизвестный автор';
  }

  if (creator) {
    return normalizeText(creator) || 'Неизвестный автор';
  }

  return 'Неизвестный автор';
}

function itemContent(item: AtomItem): string {
  return [
    item.description,
    item.content,
    item['content:encoded']
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

export class ScreenshotFeedReader {
  private readonly parser: Parser<unknown>;

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number
  ) {
    this.parser = new Parser();
  }

  async read(): Promise<FeedEntry[]> {
    const xml = await fetchText(
      this.url,
      this.timeoutMs
    );

    const feed = await this.parser.parseString(xml);
    const entries: FeedEntry[] = [];

    for (const item of feed.items as AtomItem[]) {
      // LOR использует <guid>, а не Atom <id>.
      const rawId =
        item.guid?.trim() ??
        item.id?.trim();

      const title = item.title?.trim();
      const link = item.link?.trim();
      const html = itemContent(item);

      if (!rawId || !title || !link || !html) {
        continue;
      }

      const imageUrls = extractImageUrls(html);

      // Скриншотный пост без картинки нам не нужен.
      if (imageUrls.length === 0) {
        continue;
      }

      const published =
        item.pubDate ??
        item.published ??
        item.isoDate ??
        item.updated ??
        new Date().toISOString();

      const updated =
        item.updated ??
        item.pubDate ??
        item.published ??
        item.isoDate ??
        published;

      entries.push({
        id: `lor:screenshot:${rawId}`,
        title,
        link,
        author: getAuthor(
          item.author,
          item.creator
        ),
        content: extractDescription(html),
        published,
        updated,
        source: 'screenshots',
        imageUrls
      });
    }

    return entries;
  }
}
