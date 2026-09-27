import type { AtomItem } from '../sources/atom-item.js';

/**
 * Стратегия извлечения URL картинок из сырого элемента фида.
 * Каждый сайт верстает картинки по-своему, поэтому эта логика
 * вынесена из парсера RSS в отдельные, подключаемые модули.
 *
 * Чтобы источник поддержал картинки — достаточно реализовать
 * этот интерфейс и зарегистрировать его под ключом в imageExtractorRegistry,
 * без изменений в остальном коде.
 */
export interface ImageExtractor {
  extract(item: AtomItem): string[];
}

export class NoImageExtractor implements ImageExtractor {
  extract(): string[] {
    return [];
  }
}

export class ImageExtractorRegistry {
  private readonly extractors = new Map<string, ImageExtractor>();

  constructor() {
    this.register('none', new NoImageExtractor());
  }

  register(key: string, extractor: ImageExtractor): void {
    this.extractors.set(key, extractor);
  }

  resolve(key: string | undefined): ImageExtractor {
    const extractor = this.extractors.get(key ?? 'none');

    if (!extractor) {
      throw new Error(
        `Unknown imageExtractor "${key}". Registered: ${[...this.extractors.keys()].join(', ')}`
      );
    }

    return extractor;
  }
}
