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

/**
 * Укорачивает текст до `limit` символов, НЕ разрезая последнее слово.
 *
 * Используется как fallback, когда AI-комментарий получить не удалось: полный
 * текст поста в VK-сообщение не влезает, но обрубать его на полуслове
 * («...рабочий сто») нельзя — теряется смысл и выглядит небрежно.
 *
 * Правила:
 *  - если текст короче лимита (с учётом многоточия) — возвращается как есть;
 *  - ищем последний пробел до лимита и режем по нему;
 *  - если пробела нет (один длинный токен, например URL) — режем жёстко,
 *    иначе получился бы бесконечный цикл;
 *  - многоточие добавляется только если текст действительно обрезан.
 */
export function truncateText(value: string, limit: number): string {
  const text = value.trim();

  if (limit <= 0) {
    return '';
  }

  if (text.length <= limit) {
    return text;
  }

  const ellipsis = '…';
  // Резерв под многоточие, чтобы результат гарантированно влезал в лимит.
  const budget = limit - ellipsis.length;
  const head = text.slice(0, budget);
  const lastSpace = head.lastIndexOf(' ');

  // -1 — пробела нет; обрезаем жёстко, чтобы не зациклиться.
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : head;

  return `${cut.replace(/[\s.,;:!?—–-]+$/u, '')}${ellipsis}`;
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

/**
 * Приводит любую дату фида к ISO-8601 (UTC).
 *
 * Это обязательное требование, а не косметика. RSS отдаёт время в формате
 * RFC-822 ("Wed, 29 Jul 2026 18:52:45 +0300"), и SQLite сортирует такой
 * текст ЛЕКСИКОГРАФИЧЕСКИ: "29 Jul" оказывается больше "23 Sep", потому что
 * сравниваются символы, а не даты. Из-за этого «последний пост» выбирался
 * неверно. В ISO-порядке совпадает с хронологическим.
 *
 * Если разобрать не удалось — возвращаем null, чтобы вызывающий код явно
 * решил, чем заменить неизвестную дату, а не молча записал мусор.
 */
export function toIsoDate(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);
  const time = parsed.getTime();

  return Number.isNaN(time) ? null : parsed.toISOString();
}

export function itemPublished(item: AtomItem): string {
  return (
    toIsoDate(
      firstNonEmpty(
        item.published,
        item.pubDate,
        item.isoDate,
        item.updated
      )
    ) ?? new Date().toISOString()
  );
}

export function itemUpdated(item: AtomItem, published: string): string {
  return (
    toIsoDate(
      firstNonEmpty(
        item.updated,
        item.published,
        item.isoDate,
        item.pubDate
      )
    ) ?? published
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
