import type { FeedEntry } from './types.js';
import { firstNonEmpty, toPlainText } from './text.js';

/**
 * Элемент фида в том виде, в котором его отдаёт rss-parser для Atom/RSS/RDF.
 *
 * Это единственная форма, которую видят стратегия сайта и адаптер. Полей
 * «про запас», которые rss-parser отдаёт, но проект не использует, здесь нет
 * намеренно: контракт не должен зависеть от того, что парсер когда-нибудь
 * начнёт заполнять.
 */
export interface FeedItem {
  title?: string;
  link?: string;
  id?: string;
  guid?: string;
  published?: string;
  updated?: string;
  pubDate?: string;
  content?: string;
  description?: string;
  author?: string | { name?: string };
  creator?: string;
}

/** Сырое описание элемента: все поля, где фид мог положить текст поста. */
export function itemHtmlContent(item: FeedItem): string {
  return [item.description, item.content].filter(Boolean).join('\n');
}

/** Ссылка на пост: `<link>`, а у фидов без него — `<guid>`. */
export function itemLink(item: FeedItem): string | undefined {
  return firstNonEmpty(item.link, item.guid);
}

/**
 * Ключ записи на стороне фида: Atom `<id>`, RSS/RDF — `<guid>`.
 *
 * Именно он, без префикса источника, хранится в колонке `external_id`
 * вместе с `source_id` — поэтому сравнение с записями базы всегда двухчастное.
 */
export function itemRawKey(item: FeedItem): string | undefined {
  return firstNonEmpty(item.guid, item.id);
}

/** Ключ записи целиком, в том виде, в каком он живёт в базе и в skipIds. */
export function itemEntryId(sourceId: string, item: FeedItem): string | null {
  const rawKey = itemRawKey(item);

  return rawKey ? `${sourceId}:${rawKey}` : null;
}

/**
 * Приводит любую дату фида к ISO-8601 (UTC).
 *
 * Это обязательное требование, а не косметика. RSS отдаёт время в формате
 * RFC-822 ("Wed, 29 Jul 2026 18:52:45 +0300"), а SQLite сортирует такой текст
 * ЛЕКСИКОГРАФИЧЕСКИ: "29 Jul" оказывается больше "23 Sep", потому что
 * сравниваются символы, а не даты. Из-за этого «последний пост» выбирался
 * неверно. В ISO-порядке совпадает с хронологическим.
 *
 * null, если разобрать не удалось: вызывающий код обязан явно решить, чем
 * заменить неизвестную дату, а не молча записать мусор.
 */
export function toIsoDate(value: string | undefined): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  const time = new Date(trimmed).getTime();

  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function itemPublished(item: FeedItem): string {
  return (
    toIsoDate(
      firstNonEmpty(item.published, item.pubDate, item.updated)
    ) ?? new Date().toISOString()
  );
}

export function itemUpdated(item: FeedItem, published: string): string {
  return (
    toIsoDate(
      firstNonEmpty(item.updated, item.published, item.pubDate)
    ) ?? published
  );
}

function itemAuthor(item: FeedItem): string {
  const raw =
    typeof item.author === 'string'
      ? item.author
      : (item.author?.name ?? item.creator);

  return (raw && toPlainText(raw)) || 'Неизвестный автор';
}

/**
 * Собирает запись конвейера из элемента фида.
 *
 * null означает «это не запись»: нет id, заголовка или ссылки (такое место
 * конвейеру нечего показать) либо не нашлось картинок у источника, который
 * их требует. Правила валидации живут здесь, а не в адаптере, — иначе каждый
 * новый тип источника вынужден был бы их дублировать.
 *
 * Даты уже в ISO, поэтому порядок публикации — обычное строковое сравнение.
 */
export function toFeedEntry(
  sourceId: string,
  item: FeedItem,
  options: {
    images: string[];
    description: string;
    requireImages: boolean;
  }
): FeedEntry | null {
  const rawKey = itemRawKey(item);
  const title = firstNonEmpty(item.title);
  const link = itemLink(item);

  if (!rawKey || !title || !link) {
    return null;
  }

  if (options.requireImages && options.images.length === 0) {
    return null;
  }

  const published = itemPublished(item);

  return {
    id: `${sourceId}:${rawKey}`,
    sourceId,
    title,
    link,
    author: itemAuthor(item),
    content: toPlainText(options.description),
    published,
    updated: itemUpdated(item, published),
    imageUrls: options.images
  };
}