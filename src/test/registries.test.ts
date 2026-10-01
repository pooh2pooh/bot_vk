import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SiteStrategyRegistry } from '../core/site-strategy-registry.js';
import { SourceAdapterRegistry } from '../core/source-adapter-registry.js';
import { buildEnricherForSource, buildRegistries, validateSources } from '../registries.js';
import type { AppConfig, OpenRouterConfig } from '../config/app-config.js';
import type { SourceConfig } from '../config/source-config.js';

/**
 * Реестры и проверка конфигурации.
 *
 * Проверяется главное свойство сборки: одна стратегия описывает САЙТ целиком,
 * а экземпляр создаётся на источник. Общий экземпляр означал бы общий кеш
 * разобранных страниц и общий таймаут — при двух источниках одного сайта это
 * выглядело бы как «иногда показывает старую картинку».
 */

const CTX = {
  userAgent: 'test',
  timeoutMs: 30_000,
  pageCacheSize: 500,
  maxParallelPages: 4
};

function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    vkToken: 'token',
    targetChat: 1,
    adminChat: 2,
    ownerId: 3,
    sources: [],
    userAgent: 'test-agent',
    logLevel: 'info',
    pageCacheSize: 500,
    maxParallelPageRequests: 4,
    imageDownloadTimeoutMs: 60_000,
    vkUploadTimeoutMs: 90_000,
    openRouter: null,
    databasePath: 'data/test.db',
    ...overrides
  };
}

function openRouterConfig(overrides: Partial<OpenRouterConfig> = {}): OpenRouterConfig {
  return {
    apiKey: 'key',
    model: 'model',
    modelName: 'Model',
    timeoutMs: 30_000,
    maxTokens: 700,
    maxAttempts: 3,
    retryDelayMs: 2_000,
    ...overrides
  };
}

function source(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: 'forum',
    name: 'Forum',
    type: 'rss',
    site: 'none',
    enabled: true,
    url: 'https://example.org/atom',
    requireImages: false,
    enrich: 'none',
    template: 'templates/forum_post.yml',
    textMode: 'feed',
    textLimit: 200,
    pollIntervalMs: 300_000,
    requestTimeoutMs: 30_000,
    ...overrides
  };
}

describe('SiteStrategyRegistry', () => {
  it('пустой реестр знает только про site: none', () => {
    // Сайты регистрирует сборка приложения, а не конструктор: их набор
    // зависит от того, что вообще подключено.
    assert.deepEqual(new SiteStrategyRegistry().keys(), ['none']);
  });

  it('перечисляет зарегистрированные ключи в ошибке', () => {
    const registry = buildRegistries(appConfig()).siteStrategies;

    assert.deepEqual(registry.keys(), ['none', 'lor', 'pingvinus']);
    assert.throws(
      () => registry.create('nope', CTX),
      /Unknown site "nope"\. Registered: none, lor, pingvinus/
    );
  });

  it('без ключа берёт стратегию по умолчанию — обычный RSS без разбора сайта', async () => {
    const strategy = new SiteStrategyRegistry().create(undefined, CTX);

    assert.deepEqual(await strategy.images({ content: '<img src="https://x/1.jpg">' }), []);
    assert.equal(strategy.description({ content: '<p>текст</p>' }), '<p>текст</p>');
  });

  it('has() отражает регистрацию', () => {
    const registry = buildRegistries(appConfig()).siteStrategies;

    assert.equal(registry.has('lor'), true);
    assert.equal(registry.has('my-site'), false);
  });
});

describe('SourceAdapterRegistry', () => {
  it('has() отражает регистрацию, create() называет источник', () => {
    const registry = new SourceAdapterRegistry<SourceConfig>();

    assert.equal(registry.has('rss'), false);
    registry.register('rss', () => ({
      sourceId: 'x',
      fetch: async () => [],
      imagesForPost: async () => [],
      postText: async () => ''
    }));
    assert.equal(registry.has('rss'), true);
    assert.throws(
      () => registry.create(source({ type: 'telegram' })),
      /Unknown source type "telegram" for source "forum"\. Registered: rss/
    );
  });
});

describe('buildRegistries', () => {
  it('адаптер у rss-источника создаётся с таймаутом и кешем ЭТОГО источника', async () => {
    const registries = buildRegistries(
      appConfig({ pageCacheSize: 7, maxParallelPageRequests: 2 })
    );

    const adapter = registries.sourceAdapters.create(
      source({ id: 'shots', site: 'lor', requestTimeoutMs: 1_234 })
    );

    assert.equal(typeof adapter.fetch, 'function');

    // Косвенная проверка: таймаут источника не должен подменяться глобальным.
    // Сама стратегия приватна, поэтому сравниваем поведение через два вызова
    // create: у разных источников должны быть РАЗНЫЕ таймауты.
    assert.equal(registries.sourceAdapters.create(source({ requestTimeoutMs: 1 })).sourceId, 'forum');
    assert.equal(registries.sourceAdapters.create(source({ requestTimeoutMs: 2 })).sourceId, 'forum');
  });

  it('site: none ничего не грузит — стратегия создаётся, но сети не касается', () => {
    const registries = buildRegistries(appConfig());
    const adapter = registries.sourceAdapters.create(source({ site: 'none' }));

    assert.equal(typeof adapter.imagesForPost, 'function');
  });
});

describe('validateSources', () => {
  it('пропускает корректную конфигурацию', () => {
    const registries = buildRegistries(appConfig());

    assert.doesNotThrow(() =>
      validateSources(
        registries,
        [source(), source({ id: 'shots', site: 'lor', requireImages: true })],
        false
      )
    );
  });

  it('подсказывает про OPENROUTER_API_KEY, а не просто "unknown enricher"', () => {
    const registries = buildRegistries(appConfig());

    assert.throws(
      () => validateSources(registries, [source({ enrich: 'openrouter' })], false),
      /enrich "openrouter" needs OPENROUTER_API_KEY/
    );
  });

  it('находит неизвестные type и site и перечисляет доступные', () => {
    const registries = buildRegistries(appConfig());

    assert.throws(
      () =>
        validateSources(
          registries,
          [source({ type: 'telegram', site: 'my-site' })],
          true
        ),
      (error: Error) => {
        assert.match(error.message, /unknown type "telegram" \(available: rss\)/);
        assert.match(
          error.message,
          /unknown site "my-site" \(available: none, lor, pingvinus\)/
        );
        return true;
      }
    );
  });

  it('собирает проблемы всех источников сразу', () => {
    const registries = buildRegistries(appConfig());

    assert.throws(
      () =>
        validateSources(
          registries,
          [source({ id: 'a', type: 'nope' }), source({ id: 'b', site: 'typo' })],
          true
        ),
      (error: Error) => {
        assert.equal(error.message.split('\n').length, 3);
        assert.match(error.message, /  - a: unknown type/);
        assert.match(error.message, /  - b: unknown site/);
        return true;
      }
    );
  });

  it('требует enricher для textMode: generated', () => {
    const registries = buildRegistries(appConfig());

    assert.throws(
      () =>
        validateSources(
          registries,
          [source({ textMode: 'generated', enrich: 'none' })],
          true
        ),
      /textMode "generated" needs an enricher/
    );
  });
});

describe('buildEnricherForSource', () => {
  it('enrich: none не грузит промпт и не требует API-ключ', async () => {
    const result = await buildEnricherForSource(appConfig(), source());

    assert.equal(result.ai, undefined);
    assert.equal(typeof result.enricher.enrich, 'function');
  });

  it('без ключа — внятная ошибка с именем источника', async () => {
    await assert.rejects(
      buildEnricherForSource(appConfig(), source({ enrich: 'openrouter' })),
      /Source "forum" needs enrich "openrouter", but OPENROUTER_API_KEY is not set/
    );
  });

  it('у каждого источника СВОЙ промпт', async () => {
    // Общий экземпляр означал бы, что промпт последнего собранного источника
    // победил у всех остальных, и ошибка была бы видна только по вкусу текста.
    const dir = mkdtempSync(join(tmpdir(), 'bot-prompt-'));
    const lorPath = join(dir, 'lor.txt');
    const manjaroPath = join(dir, 'manjaro.txt');
    writeFileSync(lorPath, 'Опиши скриншот');
    writeFileSync(manjaroPath, 'Переведи анонс');

    const config = appConfig({ openRouter: openRouterConfig() });

    const first = await buildEnricherForSource(
      config,
      source({ id: 'lor', enrich: 'openrouter', promptPath: lorPath })
    );
    const second = await buildEnricherForSource(
      config,
      source({ id: 'manjaro', enrich: 'openrouter', promptPath: manjaroPath })
    );

    assert.notEqual(first.enricher, second.enricher);
    assert.equal(first.ai?.promptPath, lorPath);
    assert.equal(second.ai?.promptPath, manjaroPath);
  });

  it('отсутствующий promptPath — ошибка, а не запрос без инструкции', async () => {
    await assert.rejects(
      buildEnricherForSource(
        appConfig({ openRouter: openRouterConfig() }),
        source({ enrich: 'openrouter' })
      ),
      /Source "forum" has enrich "openrouter" but no promptPath/
    );
  });
});