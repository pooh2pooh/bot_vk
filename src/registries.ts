import { EnricherRegistry } from './core/enricher.js';
import { ImageExtractorRegistry } from './core/image-extractor.js';
import { SourceAdapterRegistry } from './core/source-adapter-registry.js';
import { LorImageExtractor, extractLorDescription } from './sources/image-extractors/lor-image-extractor.js';
import { RssSourceAdapter } from './sources/rss-source-adapter.js';
import { OpenRouterEnricher } from './enrich/openrouter-enricher.js';
import type { AppConfig } from './config/app-config.js';

export interface Registries {
  sourceAdapters: SourceAdapterRegistry;
  imageExtractors: ImageExtractorRegistry;
  enrichers: EnricherRegistry;
  /** Отдельная ссылка для команд /ai status|reload, если OpenRouter настроен. */
  openRouterEnricher: OpenRouterEnricher | null;
}

/**
 * Единая точка сборки всех подключаемых стратегий.
 *
 * Чтобы добавить НОВЫЙ источник с уже существующими типом/экстрактором/
 * enrich — ничего здесь менять не нужно, достаточно config/sources.yml.
 *
 * Чтобы добавить новый ТИП источника, экстрактор картинок или способ
 * обогащения — реализуйте интерфейс (SourceAdapter / ImageExtractor /
 * Enricher) и зарегистрируйте его здесь одной строкой.
 */
export function buildRegistries(config: AppConfig): Registries {
  const imageExtractors = new ImageExtractorRegistry();
  imageExtractors.register('lor', new LorImageExtractor());

  const enrichers = new EnricherRegistry();
  let openRouterEnricher: OpenRouterEnricher | null = null;

  if (config.openRouter) {
    openRouterEnricher = new OpenRouterEnricher({
      apiKey: config.openRouter.apiKey,
      model: config.openRouter.model,
      modelName: config.openRouter.modelName,
      promptPath: config.openRouter.promptPath,
      timeoutMs: config.openRouter.timeoutMs,
      maxTokens: config.openRouter.maxTokens
    });

    enrichers.register('openrouter', openRouterEnricher);
  }

  const sourceAdapters = new SourceAdapterRegistry();

  sourceAdapters.register('rss', sourceConfig =>
    new RssSourceAdapter({
      sourceId: sourceConfig.id,
      url: sourceConfig.url,
      timeoutMs: sourceConfig.requestTimeoutMs ?? config.defaultRequestTimeoutMs,
      userAgent: config.userAgent,
      imageExtractor: imageExtractors.resolve(sourceConfig.imageExtractor),
      requireImages: sourceConfig.requireImages,
      extractDescription:
        sourceConfig.imageExtractor === 'lor' ? extractLorDescription : undefined
    })
  );

  return { sourceAdapters, imageExtractors, enrichers, openRouterEnricher };
}

/**
 * Резолвит Enricher для конкретного источника. Если источник указал
 * собственный `promptPath`, отличный от глобального — создаётся отдельный
 * экземпляр OpenRouterEnricher с этим промптом, а не общий синглтон.
 * Это позволяет нескольким источникам с enrich: openrouter иметь разные
 * "характеры" комментариев без изменения кода.
 */
export async function resolveEnricherForSource(
  registries: Registries,
  config: AppConfig,
  sourceConfig: { enrich: string; promptPath?: string }
) {
  if (
    sourceConfig.enrich === 'openrouter' &&
    sourceConfig.promptPath &&
    config.openRouter &&
    sourceConfig.promptPath !== config.openRouter.promptPath
  ) {
    const dedicated = new OpenRouterEnricher({
      apiKey: config.openRouter.apiKey,
      model: config.openRouter.model,
      modelName: config.openRouter.modelName,
      promptPath: sourceConfig.promptPath,
      timeoutMs: config.openRouter.timeoutMs,
      maxTokens: config.openRouter.maxTokens
    });

    await dedicated.loadPrompt();
    return dedicated;
  }

  return registries.enrichers.resolve(sourceConfig.enrich);
}
