import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DescriptionExtractorRegistry } from '../core/description-extractor.js';
import { EnricherRegistry, NoopEnricher } from '../core/enricher.js';
import { ImageExtractorRegistry } from '../core/image-extractor.js';
import { SourceAdapterRegistry } from '../core/source-adapter-registry.js';
import type { AppConfig } from '../config/app-config.js';
import type { SourceConfig } from '../config/source-config.js';
import { buildRegistries, validateSources } from '../registries.js';

function appConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    vkToken: 'token',
    targetChat: 1,
    adminChat: 2,
    ownerId: 3,
    sources: [],
    defaultPollIntervalMs: 60_000,
    defaultRequestTimeoutMs: 30_000,
    userAgent: 'test-agent',
    logLevel: 'info',
    imageDownloadTimeoutMs: 60_000,
    vkUploadTimeoutMs: 90_000,
    openRouter: null,
    databasePath: 'data/test.db',
    ...overrides
  };
}

function source(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: 'forum',
    name: 'Forum',
    type: 'rss',
    enabled: true,
    url: 'https://example.org/atom',
    requireImages: false,
    imageExtractor: 'none',
    enrich: 'none',
    template: 'templates/forum_post.yml',
    ...overrides
  };
}

describe('Registry', () => {
  it('перечисляет зарегистрированные ключи в ошибке', () => {
    const registry = new ImageExtractorRegistry();

    assert.deepEqual(registry.keys(), ['none']);

    assert.throws(
      () => registry.resolve('nope'),
      /Unknown imageExtractor "nope"\. Registered: none/
    );
  });

  it('resolve без ключа берёт значение по умолчанию', async () => {
    assert.deepEqual(
      await new ImageExtractorRegistry().resolve(undefined).extract({}),
      []
    );
    assert.ok(new EnricherRegistry().resolve(undefined) instanceof NoopEnricher);
  });

  it('has() отражает регистрацию', () => {
    const registry = new SourceAdapterRegistry();

    assert.equal(registry.has('rss'), false);
    registry.register('rss', () => ({ sourceId: 'x', fetch: async () => [] }));
    assert.equal(registry.has('rss'), true);
  });

  it('description-extractor по умолчанию отдаёт HTML описания', () => {
    const registry = new DescriptionExtractorRegistry();

    assert.deepEqual(registry.keys(), ['none']);
    assert.equal(
      registry.resolve('none')({ description: '<p>текст</p>' }),
      '<p>текст</p>'
    );
  });

  it('create() указывает, для какого источника не найден тип', () => {
    const registry = new SourceAdapterRegistry();
    registry.register('rss', () => ({ sourceId: 'x', fetch: async () => [] }));

    assert.throws(
      () => registry.create(source({ type: 'telegram' })),
      /Unknown source type "telegram" for source "forum"\. Registered: rss/
    );
  });
});

describe('buildRegistries', () => {
  it('enrich: openrouter доступен только при заданном API-ключе', () => {
    const withoutKey = buildRegistries(appConfig());
    const withKey = buildRegistries(
      appConfig({
        openRouter: {
          apiKey: 'key',
          model: 'model',
          modelName: 'Model',
          promptPath: 'templates/ai_comment.txt',
          timeoutMs: 30_000,
          maxTokens: 700
        }
      })
    );

    assert.equal(withoutKey.enrichers.has('openrouter'), false);
    assert.equal(withoutKey.openRouterEnricher, null);
    assert.equal(withKey.enrichers.has('openrouter'), true);
    assert.notEqual(withKey.openRouterEnricher, null);
  });

  it('imageExtractor: lor тянет за собой и разбор картинок, и чистку описания', () => {
    const registries = buildRegistries(appConfig());

    assert.equal(registries.imageExtractors.has('lor'), true);
    assert.equal(registries.descriptionExtractors.has('lor'), true);
  });
});

describe('validateSources', () => {
  it('пропускает корректную конфигурацию', () => {
    const registries = buildRegistries(appConfig());

    assert.doesNotThrow(() =>
      validateSources(registries, [
        source(),
        source({ id: 'shots', imageExtractor: 'lor', requireImages: true })
      ])
    );
  });

  it('подсказывает про OPENROUTER_API_KEY, а не просто "unknown enricher"', () => {
    const registries = buildRegistries(appConfig());

    assert.throws(
      () => validateSources(registries, [source({ enrich: 'openrouter' })]),
      /enrich "openrouter" is not available — set OPENROUTER_API_KEY/
    );
  });

  it('находит неизвестные type и imageExtractor и перечисляет доступные', () => {
    const registries = buildRegistries(appConfig());

    assert.throws(
      () =>
        validateSources(registries, [
          source({ type: 'telegram', imageExtractor: 'my-site' })
        ]),
      (error: Error) => {
        assert.match(error.message, /unknown type "telegram" \(available: rss\)/);
        assert.match(
          error.message,
          /unknown imageExtractor "my-site" \(available: none, lor, pingvinus\)/
        );
        return true;
      }
    );
  });

  it('собирает проблемы всех источников сразу', () => {
    const registries = buildRegistries(appConfig());

    assert.throws(
      () =>
        validateSources(registries, [
          source({ id: 'a', type: 'nope' }),
          source({ id: 'b', enrich: 'openrouter' })
        ]),
      (error: Error) => {
        assert.equal(error.message.split('\n').length, 3);
        assert.match(error.message, /  - a: unknown type/);
        assert.match(error.message, /  - b: enrich/);
        return true;
      }
    );
  });
});
