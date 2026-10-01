import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import YAML from 'yaml';

import { loadSources } from '../config/sources-loader.js';
import type { SourceConfig } from '../config/source-config.js';

/**
 * Загрузчик `config/sources.yml`.
 *
 * Главное, что здесь проверяется: конфиг либо полностью корректен, либо падает
 * со СПИСКОМ проблем. Молчаливый дефолт — худший вариант, потому что источник
 * выглядит рабочим, но делает не то, что написано.
 */

/** Минимально корректный источник: все обязательные поля на месте. */
function validSource(overrides: Record<string, unknown> = {}): SourceConfig {
  return {
    id: 'demo',
    name: 'Demo',
    type: 'rss',
    site: 'none',
    enabled: true,
    url: 'https://example.org/feed',
    requireImages: false,
    enrich: 'none',
    textMode: 'feed',
    textLimit: 200,
    template: 'templates/demo.yml',
    pollIntervalMs: 300_000,
    requestTimeoutMs: 30_000,
    ...overrides
  } as SourceConfig;
}

async function load(sources: unknown[]): Promise<SourceConfig[]> {
  const path = join(mkdtempSync(join(tmpdir(), 'bot-config-')), 'sources.yml');
  writeFileSync(path, YAML.stringify({ sources }));

  return loadSources(path);
}

async function loadExpectingError(sources: unknown[]): Promise<string> {
  try {
    await load(sources);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error('Ожидалась ошибка, а конфиг загрузился');
}

describe('sources-loader: корректный конфиг', () => {
  it('читает источник целиком', async () => {
    const [source] = await load([validSource()]);

    assert.equal(source?.id, 'demo');
    assert.equal(source?.textMode, 'feed');
    assert.equal(source?.textLimit, 200);
  });

  it('includeFilter и generateWhen доезжают как строки', async () => {
    const [source] = await load([
      validSource({
        enrich: 'openrouter',
        promptPath: 'templates/p.txt',
        textMode: 'feed',
        includeFilter: '^\\[Stable Update\\]',
        generateWhen: '^\\[Stable Update\\]'
      })
    ]);

    assert.equal(source?.includeFilter, '^\\[Stable Update\\]');
    assert.equal(source?.generateWhen, '^\\[Stable Update\\]');
  });

  it('regexp в одинарных кавычках не теряет обратный слэш', async () => {
    // Файл пишется руками, а не через YAML.stringify: stringify экранирует
    // по-своему и не воспроизводит ровно ту строку, о которой идёт речь.
    const path = join(mkdtempSync(join(tmpdir(), 'bot-config-')), 'sources.yml');
    writeFileSync(
      path,
      [
        'sources:',
        '  - id: m',
        "    name: M",
        '    type: rss',
        '    site: none',
        '    enabled: true',
        '    url: https://example.org/feed',
        '    requireImages: false',
        '    enrich: none',
        '    textMode: feed',
        '    textLimit: 200',
        '    template: templates/m.yml',
        '    pollIntervalMs: 300000',
        '    requestTimeoutMs: 30000',
        "    includeFilter: '^\\[Stable Update\\]'",
        ''
      ].join('\n')
    );

    const [source] = await loadSources(path);

    assert.equal(source?.includeFilter, '^\\[Stable Update\\]');
  });
});

describe('sources-loader: обязательные поля', () => {
  it('перечисляет ВСЕ отсутствующие обязательные поля сразу', async () => {
    // Бот перезапускается под pm2: падение на первом поле означало бы серию
    // рестартов с одним и тем же сообщением.
    const message = await loadExpectingError([{}]);

    for (const field of [
      'id',
      'name',
      'type',
      'site',
      'enabled',
      'url',
      'requireImages',
      'enrich',
      'textMode',
      'textLimit',
      'template',
      'pollIntervalMs',
      'requestTimeoutMs'
    ]) {
      assert.match(message, new RegExp(`\\.${field}: is required`), `нет ${field}`);
    }
  });

  it('не выводит textMode из enrich — режим обязателен', async () => {
    // Старое поведение: отсутствующий textMode вычислялся из enrich, и опечатка
    // в YAML молча превращала источник в другой источник.
    const raw = validSource({ enrich: 'openrouter', promptPath: 't.txt' }) as unknown as Record<
      string,
      unknown
    >;
    delete raw.textMode;

    assert.match(
      await loadExpectingError([raw]),
      /\.textMode: is required/
    );
  });

  it('не подставляет молчаливый дефолт вместо отсутствующего поля', async () => {
    const message = await loadExpectingError([validSource({ textLimit: undefined })]);

    assert.match(message, /\.textLimit: is required/);
  });
});

describe('sources-loader: значения полей', () => {
  it('отвергает неизвестное поле и называет допустимые', async () => {
    const message = await loadExpectingError([validSource({ includePattern: 'x' })]);

    assert.match(message, /\.includePattern: unknown field/);
    assert.match(message, /Allowed:.*includeFilter/s);
  });

  it('отвергает старые имена полей', async () => {
    // Никакой обратной совместимости: старая конфигурация должна сказать об
    // этом прямо, а не работать «как раньше».
    const message = await loadExpectingError([validSource({ imageExtractor: 'lor' })]);

    assert.match(message, /\.imageExtractor: unknown field/);
  });

  it('отвергает id не в нижнем регистре', async () => {
    const message = await loadExpectingError([validSource({ id: 'Demo' })]);

    assert.match(message, /\.id: must be a lowercase/);
  });

  it('отвергает не-http адрес', async () => {
    const message = await loadExpectingError([validSource({ url: 'ftp://example.org/f' })]);

    assert.match(message, /\.url: must be an http\(s\) URL/);
  });

  it('отвергает неизвестный режим и перечисляет допустимые', async () => {
    const message = await loadExpectingError([validSource({ textMode: 'truncated' })]);

    assert.match(message, /\.textMode: must be one of feed, feedFull, generated/);
  });

  it('отвергает неизвестный способ обогащения', async () => {
    const message = await loadExpectingError([validSource({ enrich: 'gpt' })]);

    assert.match(message, /\.enrich: must be one of none, openrouter/);
  });

  it('отвергает нецелые и неположительные интервалы', async () => {
    assert.match(
      await loadExpectingError([validSource({ pollIntervalMs: 0 })]),
      /\.pollIntervalMs: must be a positive integer/
    );
    assert.match(
      await loadExpectingError([validSource({ pollIntervalMs: 1.5 })]),
      /\.pollIntervalMs: must be a positive integer/
    );
    assert.match(
      await loadExpectingError([validSource({ textLimit: -5 })]),
      /\.textLimit: must be a positive integer/
    );
  });

  it('отвергает сломанный regexp и называет поле', async () => {
    // Сломанный шаблон тихо отсёк бы весь фид: пользователь увидел бы просто
    // пустой источник и не понял бы почему.
    const message = await loadExpectingError([
      validSource({ includeFilter: '[Stable' })
    ]);

    assert.match(message, /\.includeFilter: must be a valid regular expression/);
  });

  it('отвергает пустой фильтр', async () => {
    // `new RegExp('')` совпадает со всем: пустой шаблон тихо отключил бы
    // фильтр вместо того, чтобы сломать конфиг.
    assert.match(
      await loadExpectingError([validSource({ generateWhen: '' })]),
      /\.generateWhen: must be a valid regular expression/
    );
  });
});

describe('sources-loader: согласованность', () => {
  it('generated без enrich — ошибка, а не тихий откат на текст фида', async () => {
    const message = await loadExpectingError([validSource({ textMode: 'generated' })]);

    assert.match(message, /textMode: "generated" requires enrich/);
  });

  it('generateWhen при enrich: none бессмысленен', async () => {
    const message = await loadExpectingError([
      validSource({ generateWhen: '^Update' })
    ]);

    assert.match(message, /generateWhen: has no effect with enrich "none"/);
  });

  it('enrich без триггера генерации — ошибка: модель не была бы вызвана', async () => {
    const message = await loadExpectingError([
      validSource({ enrich: 'openrouter', promptPath: 't.txt' })
    ]);

    assert.match(message, /the enricher would never be called/);
  });

  it('enrich требует свой promptPath', async () => {
    const message = await loadExpectingError([
      validSource({ enrich: 'openrouter', textMode: 'generated' })
    ]);

    assert.match(message, /\.promptPath: is required when enrich is "openrouter"/);
  });

  it('generated вместе с generateWhen — избыточно', async () => {
    const message = await loadExpectingError([
      validSource({
        enrich: 'openrouter',
        promptPath: 't.txt',
        textMode: 'generated',
        generateWhen: '^Update'
      })
    ]);

    assert.match(message, /drop one of them/);
  });

  it('feed + generateWhen — рабочая схема выборочной генерации', async () => {
    // Именно так настроен manjaro: анонсы переводятся, новости идут как есть.
    const [source] = await load([
      validSource({
        enrich: 'openrouter',
        promptPath: 't.txt',
        textMode: 'feed',
        generateWhen: '^\\[Stable Update\\]'
      })
    ]);

    assert.equal(source?.textMode, 'feed');
    assert.equal(source?.generateWhen, '^\\[Stable Update\\]');
  });
});

describe('sources-loader: список источников', () => {
  it('отвергает пустой список', async () => {
    assert.match(await loadExpectingError([]), /must contain at least one entry/);
  });

  it('отвергает повторяющийся id один раз, а не по разу на каждое повторение', async () => {
    const message = await loadExpectingError([
      validSource({ id: 'a' }),
      validSource({ id: 'b' }),
      validSource({ id: 'a' })
    ]);

    const occurrences = message.match(/duplicate source id "a"/g) ?? [];

    assert.equal(occurrences.length, 1);
    assert.doesNotMatch(message, /duplicate source id "b"/);
  });

  it('отвергает файл без массива sources', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bot-config-')), 'sources.yml');
    writeFileSync(path, 'sources: nope\n');

    await assert.rejects(loadSources(path), /expected a top-level "sources" array/);
  });

  it('элемент не-объект — ошибка, а не молчаливый пустой источник', async () => {
    // Тихий пустой список выглядел бы как «источников просто нет».
    assert.match(await loadExpectingError(['строка']), /sources\[0\]: must be a mapping/);
    assert.match(await loadExpectingError([[1, 2]]), /sources\[0\]: must be a mapping/);
  });
});