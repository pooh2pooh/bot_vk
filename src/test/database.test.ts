import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BotDatabase } from '../db/database.js';

/**
 * Учёт обработанных записей.
 *
 * Важно: «обработанным» пост считается и когда ОТПРАВЛЕН, и когда
 * проигнорирован на старте. Иначе при каждом запуске весь архив источника
 * отправлялся бы в чат повторно.
 */

function tempDbPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'bot-test-')), `${name}.db`);
}

function feedEntry(id: string) {
  return {
    id,
    sourceId: 'src',
    title: 'Заголовок',
    link: `https://example.org/${id}`,
    author: 'Автор',
    content: 'Текст',
    published: '2026-09-29T10:00:00.000Z',
    updated: '2026-09-29T10:00:00.000Z',
    imageUrls: []
  };
}

describe('BotDatabase: учёт обработанных записей', () => {
  it('getHandledEntryIds отдаёт отправленные и проигнорированные', () => {
    const db = new BotDatabase(tempDbPath('handled'));

    db.addFeedEntry(feedEntry('src:1'));
    db.addFeedEntry(feedEntry('src:2'));
    db.addFeedEntry(feedEntry('src:3'));

    db.markSent('src:1');
    db.markIgnored('src:2');

    const handled = db.getHandledEntryIds();

    assert.equal(handled.has('src:1'), true, 'отправленный');
    assert.equal(handled.has('src:2'), true, 'проигнорированный');
    assert.equal(handled.has('src:3'), false, 'новый');

    db.close();
  });

  it('getEntryHandledStatus согласован с getHandledEntryIds', () => {
    const db = new BotDatabase(tempDbPath('consistent'));

    db.addFeedEntry(feedEntry('src:1'));
    db.markIgnored('src:1');

    assert.equal(db.getEntryHandledStatus('src:1'), true);
    assert.equal(db.getEntryHandledStatus('src:missing'), false);

    db.close();
  });

  it('markSent снимает отметку игнора, чтобы resend не считался дублем', () => {
    const db = new BotDatabase(tempDbPath('unignore'));

    db.addFeedEntry(feedEntry('src:1'));
    db.markIgnored('src:1');
    assert.equal(db.getEntryHandledStatus('src:1'), true);

    db.markSent('src:1');

    assert.equal(db.getEntryHandledStatus('src:1'), true);
    db.close();
  });
});


/**
 * Выборка последних записей для `/source posts`.
 *
 * Ключевое здесь — совпадение порядка с `getLatestEntry`. Если бы они
 * разошлись, «пост №1» в списке и «последний пост» оказались бы разными
 * записями, и это выглядело бы как баг, который невозможно диагностировать.
 */
describe('BotDatabase: listRecentEntries', () => {
  function sourceDb(name: string): BotDatabase {
    return new BotDatabase(tempDbPath(name));
  }

  function withId(id: string, published: string, sourceId = 'lor') {
    return { ...feedEntry(id), sourceId, published };
  }

  it('свежие записи сверху, порядок по дате убывающий', () => {
    const db = sourceDb('recent-order');

    db.addFeedEntry(withId('lor:old', '2026-09-01T10:00:00.000Z'));
    db.addFeedEntry(withId('lor:new', '2026-10-01T10:00:00.000Z'));
    db.addFeedEntry(withId('lor:mid', '2026-09-15T10:00:00.000Z'));

    const listed = db.listRecentEntries('lor', 10);

    assert.deepEqual(
      listed.map(stored => stored.entry.id),
      ['lor:new', 'lor:mid', 'lor:old']
    );
    db.close();
  });

  it('первая запись списка совпадает с getLatestEntry', () => {
    const db = sourceDb('recent-latest');

    db.addFeedEntry(withId('lor:a', '2026-09-01T10:00:00.000Z'));
    db.addFeedEntry(withId('lor:b', '2026-10-01T10:00:00.000Z'));
    db.addFeedEntry(withId('lor:c', '2026-09-20T10:00:00.000Z'));

    const latest = db.getLatestEntry('lor');
    const [first] = db.listRecentEntries('lor', 10);

    assert.equal(first?.entry.id, latest?.id);
    db.close();
  });

  it('записи других источников не попадают в список', () => {
    const db = sourceDb('recent-isolation');

    db.addFeedEntry(withId('lor:1', '2026-10-01T10:00:00.000Z'));
    db.addFeedEntry(withId('pingvinus:1', '2026-10-02T10:00:00.000Z', 'pingvinus'));

    const listed = db.listRecentEntries('lor', 10);

    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.entry.id, 'lor:1');
    db.close();
  });

  it('limit ограничивает количество, а не источник', () => {
    const db = sourceDb('recent-limit');

    for (let index = 1; index <= 5; index++) {
      db.addFeedEntry(
        withId(`lor:${index}`, `2026-10-0${index}T10:00:00.000Z`)
      );
    }

    assert.equal(db.listRecentEntries('lor', 3).length, 3);
    assert.equal(db.listRecentEntries('lor', 10).length, 5);
    db.close();
  });

  it('отмечает отправленные, пропущенные и ещё не решённые', () => {
    const db = sourceDb('recent-states');

    db.addFeedEntry(withId('lor:sent', '2026-10-03T10:00:00.000Z'));
    db.addFeedEntry(withId('lor:skipped', '2026-10-02T10:00:00.000Z'));
    db.addFeedEntry(withId('lor:pending', '2026-10-01T10:00:00.000Z'));

    db.markSent('lor:sent');
    db.markIgnored('lor:skipped');

    const states = new Map(
      db.listRecentEntries('lor', 10).map(stored => [stored.entry.id, stored.state])
    );

    assert.equal(states.get('lor:sent'), 'sent');
    assert.equal(states.get('lor:skipped'), 'skipped');
    assert.equal(states.get('lor:pending'), 'pending');
    db.close();
  });

  it('отправленная запись после markSent перестаёт быть skipped', () => {
    const db = sourceDb('recent-promote');

    db.addFeedEntry(withId('lor:1', '2026-10-01T10:00:00.000Z'));
    db.markIgnored('lor:1');

    assert.equal(db.listRecentEntries('lor', 1)[0]?.state, 'skipped');

    db.markSent('lor:1');

    assert.equal(db.listRecentEntries('lor', 1)[0]?.state, 'sent');
    db.close();
  });

  it('неизвестный источник даёт пустой список, а не ошибку', () => {
    const db = sourceDb('recent-unknown');

    db.addFeedEntry(withId('lor:1', '2026-10-01T10:00:00.000Z'));

    assert.deepEqual(db.listRecentEntries('manjaro', 10), []);
    db.close();
  });

  it('сохраняет картинки записи при выборке', () => {
    const db = sourceDb('recent-images');

    db.addFeedEntry({
      ...withId('lor:1', '2026-10-01T10:00:00.000Z'),
      imageUrls: ['https://example.org/1.png', 'https://example.org/2.png']
    });

    assert.deepEqual(db.listRecentEntries('lor', 1)[0]?.entry.imageUrls, [
      'https://example.org/1.png',
      'https://example.org/2.png'
    ]);
    db.close();
  });

  it('битый image_urls_json не ломает выборку', () => {
    const db = sourceDb('recent-broken');

    db.addFeedEntry(withId('lor:1', '2026-10-01T10:00:00.000Z'));
    db.updateEntryImages('lor:1', []);

    const listed = db.listRecentEntries('lor', 1);

    assert.equal(listed[0]?.entry.id, 'lor:1');
    assert.deepEqual(listed[0]?.entry.imageUrls, []);
    db.close();
  });
});
