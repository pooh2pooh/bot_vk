import he from 'he';

import type { AtomItem } from './atom-item.js';

const { decode } = he;

export function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.map(value => value?.trim()).find(Boolean);
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

export function getAuthor(
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

export function itemHtmlContent(item: AtomItem): string {
  return [item.description, item.content, item['content:encoded']]
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

export function itemPublished(item: AtomItem): string {
  return (
    firstNonEmpty(
      item.published,
      item.pubDate,
      item.isoDate,
      item.updated
    ) ?? new Date().toISOString()
  );
}

export function itemUpdated(item: AtomItem, published: string): string {
  return (
    firstNonEmpty(item.updated, item.published, item.isoDate, item.pubDate) ??
    published
  );
}

export async function fetchText(
  url: string,
  timeoutMs: number,
  userAgent: string
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': userAgent }
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
