import Parser from 'rss-parser';
import he from 'he';

import type { FeedEntry } from '../types.js';

const { decode } = he;

export interface AtomAuthor {
  name?: string;
}

export interface AtomItem {
  title?: string;
  link?: string;
  id?: string;
  guid?: string;
  published?: string;
  updated?: string;
  pubDate?: string;
  isoDate?: string;
  content?: string;
  description?: string;
  author?: string | AtomAuthor;
  creator?: string;
  categories?: string[];
  enclosure?: {
    url?: string;
    type?: string;
  };
  ['content:encoded']?: string;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values
    .map(value => value?.trim())
    .find(Boolean);
}

export function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>(?=\s*)/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeText(value: string): string {
  return stripHtml(decode(value))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function normalizeCandidateUrl(
  candidate: string,
  baseUrl: string
): string | null {
  try {
    const decoded = decode(candidate)
      .replace(/&amp;/gi, '&')
      .trim();

    const url = new URL(decoded, baseUrl);

    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }

    const hostname = url.hostname.toLowerCase();
    if (
      hostname !== 'linux.org.ru' &&
      hostname !== 'www.linux.org.ru'
    ) {
      return null;
    }

    const pathname = decodeURIComponent(url.pathname).toLowerCase();
    const isImagePath =
      pathname.startsWith('/images/') ||
      pathname.startsWith('/photos/') ||
      pathname.startsWith('/gallery/');

    if (!isImagePath) {
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

export function extractImageUrls(
  values: Array<string | undefined>,
  baseUrl = 'https://www.linux.org.ru'
): string[] {
  const urls = new Set<string>();

  for (const value of values) {
    if (!value) {
      continue;
    }

    const html = decode(value);

    const attributeRegex =
      /(?:src|href|data-src|data-original)=['"]([^'"]+)['"]/gi;

    for (const match of html.matchAll(attributeRegex)) {
      const normalized = normalizeCandidateUrl(
        match[1],
        baseUrl
      );

      if (normalized) {
        urls.add(normalized);
      }
    }

    const plainUrlRegex =
      /https?:\/\/[^\s"'<>]+?\.(?:png|jpe?g|webp|gif|avif)(?:\?[^\s"'<>]*)?/gi;

    for (const match of html.matchAll(plainUrlRegex)) {
      const normalized = normalizeCandidateUrl(
        match[0],
        baseUrl
      );

      if (normalized) {
        urls.add(normalized);
      }
    }
  }

  return [...urls];
}

export async function fetchText(
  url: string,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ManjaroRU-VK-Feed-Bot/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(
        `Feed request failed: HTTP ${response.status} ${response.statusText}`
      );
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function getAuthor(author: AtomItem['author'], creator?: string): string {
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

export class FeedReader {
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

    return (feed.items as AtomItem[])
      .map((item): FeedEntry | null => {
        const id = item.id?.trim();
        const title = item.title?.trim();
        const link = item.link?.trim();

        if (!id || !title || !link) {
          return null;
        }

        const published = firstNonEmpty(
          item.published,
          item.pubDate,
          item.isoDate,
          item.updated
        ) ?? new Date().toISOString();

        const updated = firstNonEmpty(
          item.updated,
          item.published,
          item.isoDate,
          item.pubDate
        ) ?? published;

        return {
          id,
          title,
          link,
          author: getAuthor(item.author, item.creator),
          content: normalizeText(
            item.content ?? item.description ?? ''
          ),
          published,
          updated,
          source: 'forum',
          imageUrls: []
        };
      })
      .filter((entry): entry is FeedEntry => entry !== null);
  }
}
