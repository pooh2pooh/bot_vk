import type { FeedEntry } from './types.js';
import { Registry } from './registry.js';

export interface EnrichResult {
  entry: FeedEntry;
  /** Произвольные метаданные для логов (например, время генерации AI). */
  meta?: Record<string, string | number>;
}

/**
 * Обогащает запись перед рендером шаблона (например, AI-комментарий вместо
 * исходного текста). Обогащение никогда не должно быть обязательным условием
 * отправки: конвейер (SourcePipeline) ловит ошибки Enricher'а и отправляет
 * исходную запись как fallback.
 */
export interface Enricher {
  enrich(entry: FeedEntry): Promise<EnrichResult>;
}

export class NoopEnricher implements Enricher {
  async enrich(entry: FeedEntry): Promise<EnrichResult> {
    return { entry };
  }
}

export class EnricherRegistry extends Registry<Enricher> {
  protected readonly kind = 'enricher';

  constructor() {
    super();
    this.register('none', new NoopEnricher());
  }

  resolve(key: string | undefined): Enricher {
    return this.require(key ?? 'none');
  }
}
