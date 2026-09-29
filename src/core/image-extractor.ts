import type { AtomItem } from './atom-item.js';
import { Registry } from './registry.js';

/**
 * Стратегия извлечения URL картинок из сырого элемента фида.
 * Каждый сайт верстает картинки по-своему, поэтому эта логика
 * вынесена из парсера RSS в отдельные, подключаемые модули.
 *
 * Чтобы источник поддержал картинки — достаточно реализовать
 * этот интерфейс и зарегистрировать его под ключом в imageExtractorRegistry,
 * без изменений в остальном коде.
 *
 * Метод асинхронный, потому что стратегии разрешено догружать недостающее:
 * RSS-фиды бывают lossy и не содержат всех картинок поста (так ведёт себя
 * RSS linux.org.ru — в описании лежит только первая картинка галереи).
 */
export interface ImageExtractor {
  extract(item: AtomItem): Promise<string[]>;
  /**
   * Переизвлекает картинки по прямой ссылке на пост, без записи в фиде.
   *
   * Нужно для resend: посты в базе — старые, их давно нет в фиде (RSS держит
   * только последние N записей), поэтому перечитать фид бесполезно. Страница
   * же самого поста доступна всегда.
   *
   * Опционально: стратегия, которая не умеет ходить на страницу, не
   * реализует метод, и вызывающий код остаётся на сохранённом значении.
   */
  extractFromUrl?(url: string): Promise<string[]>;
  /**
   * Достаёт исходный текст поста по прямой ссылке.
   *
   * Нужен как fallback, когда AI-комментарий получить не удалось, а в фиде
   * текста нет: некоторые сайты (pingvinus) отдают в RSS пустое описание и
   * держат весь текст на странице.
   *
   * Опционально: стратегия, которая не умеет ходить на страницу, не
   * реализует метод, и fallback остаётся без исходного текста.
   */
  extractTextFromUrl?(url: string): Promise<string>;
}

export class NoImageExtractor implements ImageExtractor {
  async extract(): Promise<string[]> {
    return [];
  }
}

export class ImageExtractorRegistry extends Registry<ImageExtractor> {
  protected readonly kind = 'imageExtractor';

  constructor() {
    super();
    this.register('none', new NoImageExtractor());
  }

  resolve(key: string | undefined): ImageExtractor {
    return this.require(key ?? 'none');
  }
}
