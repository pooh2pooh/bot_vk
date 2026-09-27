import type { FeedEntry } from './types.js';

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

export class EnricherRegistry {
  private readonly enrichers = new Map<string, Enricher>();

  constructor() {
    this.register('none', new NoopEnricher());
  }

  register(key: string, enricher: Enricher): void {
    this.enrichers.set(key, enricher);
  }

  resolve(key: string | undefined): Enricher {
    const enricher = this.enrichers.get(key ?? 'none');

    if (!enricher) {
      throw new Error(
        `Unknown enricher "${key}". Registered: ${[...this.enrichers.keys()].join(', ')}`
      );
    }

    return enricher;
  }
}
