import he from 'he';

import type { ImageExtractor } from '../../core/image-extractor.js';
import type { AtomItem } from '../atom-item.js';
import { itemHtmlContent } from '../text-utils.js';

const { decode } = he;

interface ImageCandidate {
  url: string;
  width: number;
  priority: number;
  order: number;
}

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

export class LorImageExtractor implements ImageExtractor {
  constructor(private readonly baseUrl = 'https://www.linux.org.ru') {}

  extract(item: AtomItem): string[] {
    const source = decode(itemHtmlContent(item));
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
      add(match[1]);
    }

    // Responsive images: srcset="...500w, ...1000w, ...1500w".
    const srcsetRegex =
      /\b(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi;

    for (const match of source.matchAll(srcsetRegex)) {
      parseSrcset(match[1], this.baseUrl, add);
    }

    // Иногда LOR оставляет URL картинки обычным текстом в HTML.
    const rawUrlRegex =
      /(?:https?:\/\/(?:www\.)?linux\.org\.ru|)(?:\/(?:images|photos)\/[^\s"'<>),]+\.(?:png|jpe?g|webp|gif|avif))/gi;

    for (const match of source.matchAll(rawUrlRegex)) {
      const value = match[0].startsWith('http')
        ? match[0]
        : match[0];
      add(value);
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
      .map(list =>
        [...list].sort((a, b) =>
          b.priority - a.priority ||
          b.width - a.width ||
          a.order - b.order
        )[0].url
      );
  }
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
