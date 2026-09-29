import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { FeedEntry } from '../core/types.js';
import { TemplateManager } from '../templates/manager.js';

let dir: string;
let manager: TemplateManager;

const ENTRY: FeedEntry = {
  id: 'forum:1',
  sourceId: 'forum',
  title: 'Заголовок поста',
  link: 'https://example.org/1',
  author: 'Аноним',
  content: 'Тело поста',
  published: '2026-09-27T10:00:00.000Z',
  updated: '2026-09-27T10:05:00.000Z',
  imageUrls: []
};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vk-feed-bot-templates-'));

  await writeFile(
    join(dir, 'post.yml'),
    'type: post\ntemplate: |\n  💬 {title}\n  {content}\n  — 👤 {author}\n  🔗 {link}\n',
    'utf8'
  );

  await writeFile(
    join(dir, 'broken.yml'),
    'type: post\nnotemplate: |\n  что-то\n',
    'utf8'
  );

  manager = new TemplateManager();
  manager.register('forum', join(dir, 'post.yml'));
  await manager.load();
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('TemplateManager', () => {
  it('подставляет все плейсхолдеры', () => {
    // Блочный скаляр YAML (`|`) сохраняет финальный перевод строки,
    // поэтому он попадает в сообщение — это ожидаемо и безвредно для VK.
    const rendered = manager.render('forum', ENTRY);

    assert.equal(
      rendered,
      [
        '💬 Заголовок поста',
        'Тело поста',
        '— 👤 Аноним',
        '🔗 https://example.org/1',
        ''
      ].join('\n')
    );
  });

  it('поддерживает published и updated', async () => {
    const local = new TemplateManager();
    const path = join(dir, 'dates.yml');

    await writeFile(path, 'template: "{published}|{updated}"\n', 'utf8');
    local.register('forum', path);
    await local.load();

    assert.equal(
      local.render('forum', ENTRY),
      '2026-09-27T10:00:00.000Z|2026-09-27T10:05:00.000Z'
    );
  });

  it('неизвестный плейсхолдер остаётся как есть', async () => {
    const local = new TemplateManager();
    const path = join(dir, 'unknown.yml');

    await writeFile(path, 'template: "{title} {nope}"\n', 'utf8');
    local.register('forum', path);
    await local.load();

    assert.equal(local.render('forum', ENTRY), 'Заголовок поста {nope}');
  });

  it('бросает понятную ошибку для незарегистрированного источника', () => {
    assert.throws(
      () => manager.render('unknown-source', ENTRY),
      /Template not loaded for source: unknown-source/
    );
  });

  it('бросает ошибку, если файл шаблона невалиден', async () => {
    manager.register('broken', join(dir, 'broken.yml'));

    await assert.rejects(
      () => manager.loadOne('broken'),
      /Invalid template:/
    );
  });

  it('перечитывает шаблон с диска', async () => {
    const path = join(dir, 'post.yml');
    const original = await readFileUtf8(path);

    try {
      await writeFile(path, 'template: "новый {title}"\n', 'utf8');
      await manager.loadOne('forum');

      assert.equal(manager.render('forum', ENTRY), 'новый Заголовок поста');
    } finally {
      await writeFile(path, original, 'utf8');
      await manager.loadOne('forum');
    }
  });
});

async function readFileUtf8(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}
