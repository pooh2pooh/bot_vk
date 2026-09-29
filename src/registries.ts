import { DescriptionExtractorRegistry } from './core/description-extractor.js';
import { EnricherRegistry } from './core/enricher.js';
import { ImageExtractorRegistry } from './core/image-extractor.js';
import { SourceAdapterRegistry } from './core/source-adapter-registry.js';
import { LorImageExtractor, extractLorDescription } from './sources/image-extractors/lor-image-extractor.js';
import {
  PingvinusImageExtractor,
  extractPingvinusDescription
} from './sources/image-extractors/pingvinus-image-extractor.js';
import { RssSourceAdapter } from './sources/rss-source-adapter.js';
import { OpenRouterEnricher } from './enrich/openrouter-enricher.js';
import type { AppConfig } from './config/app-config.js';
import type { SourceConfig } from './config/source-config.js';

export interface Registries {
  sourceAdapters: SourceAdapterRegistry<SourceConfig>;
  imageExtractors: ImageExtractorRegistry;
  descriptionExtractors: DescriptionExtractorRegistry;
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
 *
 * Заметьте, что особенности сайта описываются ключом в sources.yml, а не
 * сравнением с конкретным именем прямо в этом файле: реестры картинок и
 * описаний используют один и тот же ключ (`imageExtractor`), поэтому
 * `imageExtractor: lor` подтягивает и разбор URL картинок, и чистку
 * описания LOR без единого `if (source.imageExtractor === 'lor')`.
 */
export function buildRegistries(config: AppConfig): Registries {
  const imageExtractors = new ImageExtractorRegistry();
  imageExtractors.register(
    'lor',
    new LorImageExtractor({
      userAgent: config.userAgent,
      requestTimeoutMs: config.defaultRequestTimeoutMs
    })
  );

  imageExtractors.register(
    'pingvinus',
    new PingvinusImageExtractor({
      userAgent: config.userAgent,
      requestTimeoutMs: config.defaultRequestTimeoutMs
    })
  );

  const descriptionExtractors = new DescriptionExtractorRegistry();
  descriptionExtractors.register('lor', extractLorDescription);
  descriptionExtractors.register('pingvinus', extractPingvinusDescription);

  const enrichers = new EnricherRegistry();
  let openRouterEnricher: OpenRouterEnricher | null = null;

  if (config.openRouter) {
    openRouterEnricher = createOpenRouterEnricher(config, config.openRouter.promptPath);
    enrichers.register('openrouter', openRouterEnricher);
  }

  const sourceAdapters = new SourceAdapterRegistry<SourceConfig>();

  sourceAdapters.register('rss', sourceConfig =>
    new RssSourceAdapter({
      sourceId: sourceConfig.id,
      url: sourceConfig.url,
      timeoutMs: sourceConfig.requestTimeoutMs ?? config.defaultRequestTimeoutMs,
      userAgent: config.userAgent,
      imageExtractor: imageExtractors.resolve(sourceConfig.imageExtractor),
      requireImages: sourceConfig.requireImages,
      extractDescription: descriptionExtractors.resolve(
        sourceConfig.imageExtractor
      ),
      includePattern: compileIncludePattern(sourceConfig.includePattern)
    })
  );

  return {
    sourceAdapters,
    imageExtractors,
    descriptionExtractors,
    enrichers,
    openRouterEnricher
  };
}

/**
 * Компилирует includePattern из sources.yml в регулярку БЕЗ флагов.
 *
 * Флаги здесь нельзя задать в принципе: sources.yml — это строка, а не литерал
 * регулярки, так что `new RegExp(pattern)` создаёт выражение без lastIndex.
 * Это важно — с флагом `g` повторный .test() на одной строке чередовал бы
 * true/false, а источник проверяет каждую запись много раз за цикл, и такой
 * баг выглядел бы как «иногда работает, иногда нет».
 */
function compileIncludePattern(
  pattern: string | undefined
): RegExp | undefined {
  return pattern ? new RegExp(pattern) : undefined;
}

/**
 * Проверяет, что все стратегии, упомянутые в sources.yml, реально
 * зарегистрированы, и собирает ВСЕ проблемы в одну ошибку.
 *
 * Без этой проверки неизвестный ключ всплывал бы из середины цикла сборки
 * пайплайнов: сначала упал бы весь бот, а сообщение не подсказывало бы, что
 * именно не так (`enrich: openrouter` без OPENROUTER_API_KEY, опечатка в
 * `imageExtractor`, несуществующий `type`).
 */
export function validateSources(
  registries: Registries,
  sources: SourceConfig[]
): void {
  const issues: string[] = [];

  for (const source of sources) {
    if (!registries.sourceAdapters.has(source.type)) {
      issues.push(
        `  - ${source.id}: unknown type "${source.type}" (available: ${registries.sourceAdapters.keys().join(', ')})`
      );
    }

    if (!registries.imageExtractors.has(source.imageExtractor)) {
      issues.push(
        `  - ${source.id}: unknown imageExtractor "${source.imageExtractor}" (available: ${registries.imageExtractors.keys().join(', ')})`
      );
    }

    if (!registries.enrichers.has(source.enrich)) {
      const hint =
        source.enrich === 'openrouter'
          ? ' — set OPENROUTER_API_KEY in .env, or set "enrich: none" for this source'
          : '';

      issues.push(
        `  - ${source.id}: enrich "${source.enrich}" is not available${hint}`
      );
    }
  }

  if (issues.length > 0) {
    throw new Error(
      `Unresolvable strategies in sources configuration:\n${issues.join('\n')}`
    );
  }
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
    const dedicated = createOpenRouterEnricher(config, sourceConfig.promptPath);

    await dedicated.loadPrompt();
    return dedicated;
  }

  return registries.enrichers.resolve(sourceConfig.enrich);
}

/**
 * Собирает OpenRouterEnricher из общих настроек приложения.
 *
 * Вынесено, потому что экземпляр создаётся в двух местах: общий (для всех
 * источников с enrich: openrouter) и отдельный для источника со своим
 * promptPath. Дублировать список полей здесь означало бы получить новый
 * параметр OpenRouter, о котором один из путей забудет.
 */
function createOpenRouterEnricher(
  config: AppConfig,
  promptPath: string
): OpenRouterEnricher {
  if (!config.openRouter) {
    throw new Error('OpenRouter is not configured');
  }

  return new OpenRouterEnricher({ ...config.openRouter, promptPath });
}
