import type { AtomItem } from './atom-item.js';
import { Registry } from './registry.js';
import { itemHtmlContent } from './text-utils.js';

/**
 * Стратегия извлечения текстового описания из элемента фида.
 *
 * Ключи этого реестра совпадают с ключами ImageExtractorRegistry: особенности
 * одного сайта (как выбирать URL картинок И как вырезать из описания блоки с
 * картинками) — это одна и та же «стратегия сайта», поэтому отдельный YAML-ключ
 * не нужен. Источник с `imageExtractor: lor` автоматически получает и
 * чистку описания LOR.
 */
export type DescriptionExtractor = (item: AtomItem) => string;

export class DescriptionExtractorRegistry extends Registry<DescriptionExtractor> {
  protected readonly kind = 'description extractor';

  constructor() {
    super();
    this.register('none', item => itemHtmlContent(item));
  }

  resolve(key: string | undefined): DescriptionExtractor {
    return this.require(key ?? 'none');
  }
}
