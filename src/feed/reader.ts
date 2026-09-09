import Parser from 'rss-parser';
import he from 'he';

import type { FeedEntry } from '../types.js';

const { decode } = he;

interface AtomItem {
  title?: string;
  link?: string;
  id?: string;
  published?: string;
  updated?: string;
  content?: string;
  author?: string;
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeText(value: string): string {
  return stripHtml(decode(value))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
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
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await fetch(this.url, {
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

      const xml = await response.text();

      const feed = await this.parser.parseString(xml);

      return (feed.items as AtomItem[])
        .map((item): FeedEntry | null => {
          const id = item.id?.trim();
          const title = item.title?.trim();
          const link = item.link?.trim();

          if (!id || !title || !link) {
            return null;
          }

          return {
            id,
            title,
            link,
            author: normalizeText(item.author ?? 'Неизвестный автор'),
            content: normalizeText(item.content ?? ''),
            published: item.published ?? item.updated ?? new Date().toISOString(),
            updated: item.updated ?? item.published ?? new Date().toISOString()
          };
        })
        .filter((entry): entry is FeedEntry => entry !== null);
    } finally {
      clearTimeout(timeout);
    }
  }
}
