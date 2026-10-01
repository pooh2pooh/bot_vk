import { SiteStrategyRegistry } from './core/site-strategy-registry.js';
import { NoopEnricher, type Enricher } from './core/enricher.js';
import { SourceAdapterRegistry } from './core/source-adapter-registry.js';
import { LorSite } from './sources/sites/lor.js';
import { PingvinusSite } from './sources/sites/pingvinus.js';
import { RssSourceAdapter } from './sources/rss-source-adapter.js';
import { OpenRouterEnricher } from './enrich/openrouter-enricher.js';
import { compileFilter } from './core/filter.js';
import { toMessage } from './utils/to-message.js';
import type { SiteStrategy } from './core/site-strategy.js';
import type { AppConfig } from './config/app-config.js';
import type { SourceConfig } from './config/source-config.js';

export interface Registries {
  sourceAdapters: SourceAdapterRegistry<SourceConfig>;
  siteStrategies: SiteStrategyRegistry;
}

/**
 * Источник с генерацией текста. Именно эти данные показывает `/ai status`.
 */
export interface AiSource {
  sourceId: string;
  sourceName: string;
  promptPath: string;
  model: string;
  modelName: string;
  /** Прямая ссылка на загрузку промпта: для `/ai reload`. */
  reloadPrompt: () => Promise<void>;
}

/**
 * Единственная точка сборки всех подключаемых стратегий.
 *
 * Добавить источник с уже существующим сайтом и `enrich` — только правка
 * `config/sources.yml`, здесь ничего менять не нужно.
 *
 * Добавить новый САЙТ — реализовать `SiteStrategy` и зарегистрировать его одной
 * строкой. Новый ТИП источника — `SourceAdapter`. Новый способ генерации —
 * `Enricher`.
 *
 * Заметьте: особенности сайта описываются ключом `site` в YAML, а не сравнением
 * с конкретным именем прямо здесь. Одна стратегия описывает сайт целиком, поэтому
 * в конфиге не может оказаться `site: lor` в паре с чисткой чужого сайта.
 */
export function buildRegistries(config: AppConfig): Registries {
  const siteStrategies = new SiteStrategyRegistry();

  siteStrategies.register('lor', ctx => new LorSite(ctx));
  siteStrategies.register('pingvinus', ctx => new PingvinusSite(ctx));

  const sourceAdapters = new SourceAdapterRegistry<SourceConfig>();

  sourceAdapters.register('rss', sourceConfig => {
    /*
     * Фильтр компилируется здесь, один раз на источник, а не на каждый пост:
     * создание RegExp в цикле — лишняя работа в самом горячем месте опроса.
     * Ошибку компиляции уже исключил загрузчик конфига.
     */
    const includeFilter = sourceConfig.includeFilter
      ? compileFilter(
          sourceConfig.includeFilter,
          `${sourceConfig.id}.includeFilter`
        )
      : undefined;

    /*
     * Стратегия создаётся НА ИСТОЧНИК, а не хранится в реестре готовым
     * объектом. Так у каждого источника свои таймаут и свой кеш разобранных
     * страниц: два источника одного сайта не делят кеш, и у site: none стратегия
     * вообще ничего не грузит.
     */
    const strategy: SiteStrategy = siteStrategies.create(
      sourceConfig.site,
      {
        userAgent: config.userAgent,
        timeoutMs: sourceConfig.requestTimeoutMs,
        pageCacheSize: config.pageCacheSize,
        maxParallelPages: config.maxParallelPageRequests
      }
    );

    return new RssSourceAdapter({
      sourceId: sourceConfig.id,
      feedUrl: sourceConfig.url,
      timeoutMs: sourceConfig.requestTimeoutMs,
      userAgent: config.userAgent,
      includeFilter,
      requireImages: sourceConfig.requireImages,
      strategy,
      onStrategyError: error =>
        console.error(`[SOURCE] ${sourceConfig.id}: ${toMessage(error)}`)
    });
  });

  return { sourceAdapters, siteStrategies };
}

/**
 * Проверяет, что все стратегии, упомянутые в sources.yml, зарегистрированы, и
 * собирает ВСЕ проблемы в одну ошибку.
 *
 * Без этой проверки неизвестный ключ всплывал бы из середины цикла сборки
 * пайплайнов: сначала упал бы весь бот, а сообщение не подсказывало бы, что
 * именно не так (`enrich: openrouter` без OPENROUTER_API_KEY, опечатка в
 * `site`, несуществующий `type`).
 */
export function validateSources(
  registries: Registries,
  sources: SourceConfig[],
  aiConfigured: boolean
): void {
  const issues: string[] = [];

  for (const source of sources) {
    if (!registries.sourceAdapters.has(source.type)) {
      issues.push(
        `  - ${source.id}: unknown type "${source.type}" (available: ${registries.sourceAdapters.keys().join(', ')})`
      );
    }

    if (!registries.siteStrategies.has(source.site)) {
      issues.push(
        `  - ${source.id}: unknown site "${source.site}" (available: ${registries.siteStrategies.keys().join(', ')})`
      );
    }

    if (!aiConfigured && source.enrich !== 'none') {
      issues.push(
        `  - ${source.id}: enrich "${source.enrich}" needs OPENROUTER_API_KEY in .env, or set "enrich: none"`
      );
    }

    if (source.textMode === 'generated' && source.enrich === 'none') {
      issues.push(
        `  - ${source.id}: textMode "generated" needs an enricher — add "enrich: openrouter" or use textMode: feed`
      );
    }
  }

  if (issues.length > 0) {
    throw new Error(
      `Unresolvable strategies in sources configuration:\n${issues.join('\n')}`
    );
  }
}

/** Обогатитель источника и, если он AI, — данные для `/ai status`. */
export interface SourceEnricher {
  enricher: Enricher;
  ai?: AiSource;
}

/**
 * Собирает обогатитель источника.
 *
 * Экземпляр OpenRouterEnricher создаётся НА ИСТОЧНИК, а не один на всех:
 * промпты у источников разные (перевод анонса, описание скриншота), а промпт
 * живёт в объекте. Общий экземпляр означал бы, что промпт последнего собранного
 * источника победил у всех остальных — и ошибка была бы видна только по вкусу
 * текста в чате.
 */
export async function buildEnricherForSource(
  config: AppConfig,
  sourceConfig: SourceConfig
): Promise<SourceEnricher> {
  if (sourceConfig.enrich === 'none') {
    return { enricher: new NoopEnricher() };
  }

  const openRouter = config.openRouter;
  const promptPath = sourceConfig.promptPath;

  if (!openRouter) {
    throw new Error(
      `Source "${sourceConfig.id}" needs enrich "${sourceConfig.enrich}", but OPENROUTER_API_KEY is not set`
    );
  }

  if (!promptPath) {
    throw new Error(
      `Source "${sourceConfig.id}" has enrich "${sourceConfig.enrich}" but no promptPath`
    );
  }

  const enricher = new OpenRouterEnricher(openRouter);

  await enricher.loadPrompt(promptPath, sourceConfig.id);

  return {
    enricher,
    ai: {
      sourceId: sourceConfig.id,
      sourceName: sourceConfig.name,
      promptPath,
      model: openRouter.model,
      modelName: openRouter.modelName,
      reloadPrompt: () => enricher.loadPrompt(promptPath)
    }
  };
}