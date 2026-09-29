import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { loadSources } from '../config/sources-loader.js';

let dir: string;
let counter = 0;

/** Пишет sources.yml во временный файл и парсит его. */
async function load(yaml: string) {
  const path = join(dir, `sources-${counter++}.yml`);
  await writeFile(path, yaml, 'utf8');
  return loadSources(path);
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vk-feed-bot-sources-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadSources', () => {
  it('подставляет дефолты для необязательных полей', async () => {
    const [source] = await load(`
sources:
  - id: forum
    url: https://example.org/atom
    template: templates/forum_post.yml
`);

    assert.equal(source?.id, 'forum');
    assert.equal(source?.name, 'forum');
    assert.equal(source?.type, 'rss');
    assert.equal(source?.enabled, true);
    assert.equal(source?.requireImages, false);
    assert.equal(source?.imageExtractor, 'none');
    assert.equal(source?.enrich, 'none');
    assert.equal(source?.pollIntervalMs, undefined);
    assert.equal(source?.promptPath, undefined);
  });

  it('читает все явно заданные поля', async () => {
    const [source] = await load(`
sources:
  - id: screenshots
    name: LOR Screenshots
    type: rss
    enabled: false
    url: https://example.org/rss
    requireImages: true
    imageExtractor: lor
    enrich: openrouter
    template: templates/screenshot_post.yml
    pollIntervalMs: 120000
    requestTimeoutMs: 15000
    promptPath: templates/other_prompt.txt
`);

    assert.equal(source?.name, 'LOR Screenshots');
    assert.equal(source?.enabled, false);
    assert.equal(source?.requireImages, true);
    assert.equal(source?.imageExtractor, 'lor');
    assert.equal(source?.enrich, 'openrouter');
    assert.equal(source?.pollIntervalMs, 120_000);
    assert.equal(source?.requestTimeoutMs, 15_000);
    assert.equal(source?.promptPath, 'templates/other_prompt.txt');
  });

  it('собирает проблемы всех источников в одно сообщение', async () => {
    await assert.rejects(
      () =>
        load(`
sources:
  - id: Bad_Id
    url: https://example.org/atom
    template: t.yml
  - id: second
    url: ftp://example.org/atom
    template: t.yml
  - id: third
    url: https://example.org/atom
  - id: ok
    url: https://example.org/atom
    template: t.yml
`),
      (error: Error) => {
        const message = error.message;

        assert.match(message, /sources\[0\]: id must be a lowercase/);
        assert.match(message, /sources\[1\]\.url: must be a valid http\(s\) URL/);
        assert.match(message, /sources\[2\]\.template: is required/);
        return true;
      }
    );
  });

  it('внутри одного источника проверяет до первой ошибки', async () => {
    // parseOne выходит на первом невалидном поле, поэтому следующие
    // проблемы того же источника не выводятся — зато падать боту не даёт
    // ни одна из них: пользователь видит всё, что нужно исправить.
    await assert.rejects(
      () =>
        load(`
sources:
  - id: Bad_Id
    url: ftp://example.org/atom
    template: t.yml
`),
      (error: Error) => {
        const lines = error.message
          .split('\n')
          .filter(line => line.includes('sources[0]'));

        assert.equal(lines.length, 1);
        assert.match(error.message, /sources\[0\]: id must be a lowercase/);
        return true;
      }
    );
  });

  it('ловит дубликаты id', async () => {
    await assert.rejects(
      () =>
        load(`
sources:
  - id: forum
    url: https://example.org/a
    template: t.yml
  - id: forum
    url: https://example.org/b
    template: t.yml
`),
      /duplicate source id "forum"/
    );
  });

  it('требует хотя бы один источник', async () => {
    await assert.rejects(() => load('sources: []'), /at least one entry/);
  });

  it('требует верхнеуровневый массив sources', async () => {
    await assert.rejects(
      () => load('other: 1'),
      /expected a top-level "sources" array/
    );
  });

  it('отвергает id с недопустимыми символами', async () => {
    await assert.rejects(
      () =>
        load(`
sources:
  - id: "Плохой id"
    url: https://example.org/atom
    template: t.yml
`),
      /id must be a lowercase a-z0-9_- string/
    );
  });

  it('отвергает нечисловые интервалы', async () => {
    await assert.rejects(
      () =>
        load(`
sources:
  - id: forum
    url: https://example.org/atom
    template: t.yml
    requestTimeoutMs: soon
`),
      /requestTimeoutMs: must be a number/
    );
  });
});
