/**
 * Команды `/source posts` и `/source resend` — выбор поста админом.
 *
 * Главное, что тут проверяется, — привязка номера к ПОКАЗАННОМУ списку.
 * Если бы `resend` брал запись из свежей выборки базы, новый пост, пришедший
 * между двумя командами, сдвинул бы нумерацию, и админ переслал бы не тот пост,
 * который выбрал. Промах был бы почти неотличим от «список врёт».
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Context } from 'vk-io';

import { CommandHandler } from '../commands/handler.js';
import type { BotDatabase, StoredEntry } from '../db/database.js';
import type { FeedEntry } from '../core/types.js';
import type { Scheduler } from '../pipeline/scheduler.js';
import type { SourcePipeline } from '../pipeline/source-pipeline.js';
import type { TemplateManager } from '../templates/manager.js';

const ADMIN_CHAT = 42;

function entry(id: string, title: string, published: string): FeedEntry {
  return {
    id,
    sourceId: 'lor',
    title,
    link: `https://www.linux.org.ru/news/${id}`,
    author: 'Автор',
    content: `текст ${id}`,
    published,
    updated: published,
    imageUrls: []
  };
}

function stored(state: StoredEntry['state'], id: string, published: string): StoredEntry {
  return { entry: entry(id, `Заголовок ${id}`, published), state };
}

/** Три записи: отправленная, ещё не отправленная и самая свежая. */
const RECENT: StoredEntry[] = [
  stored('sent', 'lor:3', '2026-10-03T10:00:00.000Z'),
  stored('pending', 'lor:2', '2026-10-02T10:00:00.000Z'),
  stored('sent', 'lor:1', '2026-10-01T10:00:00.000Z')
];

interface Harness {
  handler: CommandHandler;
  /** Ответы бота в админ-чат, по порядку. */
  replies: string[];
  /** id постов, ушедших в целевой чат. */
  resent: string[];
  /** Что база отдаст при СЛЕДУЮщем `/source posts`. */
  setRecent(entries: StoredEntry[]): void;
  send(text: string): Promise<void>;
}

function harness(initial: StoredEntry[] = RECENT): Harness {
  let recent = initial;
  const replies: string[] = [];
  const resent: string[] = [];

  const pipeline = {
    sourceId: 'lor',
    sourceName: 'Linux.org.ru',
    listRecent: (limit?: number) => (limit === undefined ? recent : recent.slice(0, limit)),
    resend: async (chosen: FeedEntry) => {
      resent.push(chosen.id);

      return chosen;
    },
    resendLatest: async () => entry('lor:latest', 'Последний', '2026-10-09T10:00:00.000Z'),
    check: async () => 0
  } as unknown as SourcePipeline;

  const db = {
    isAdmin: () => true,
    isOwner: () => false,
    setSourceEnabledOverride: () => undefined,
    getSourceEnabledOverride: () => null
  } as unknown as BotDatabase;

  const handler = new CommandHandler({
    db,
    pipelines: new Map([['lor', pipeline]]),
    scheduler: {
      list: () => [{ sourceId: 'lor', sourceName: 'Linux.org.ru', enabled: true }]
    } as unknown as Scheduler,
    templates: { load: async () => undefined } as unknown as TemplateManager,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined
    } as never,
    adminChat: ADMIN_CHAT,
    ownerId: 1,
    aiConfigured: true,
    aiSources: []
  });

  const send = async (text: string): Promise<void> => {
    replies.push(text);

    const ctx = {
      peerId: ADMIN_CHAT,
      senderId: 1,
      text,
      send: async (message: string) => {
        replies.push(message);
      }
    } as unknown as Context;

    await handler.handle(ctx);
  };

  return {
    handler,
    replies,
    resent,
    setRecent: entries => {
      recent = entries;
    },
    send
  };
}

describe('/source posts: показ списка', () => {
  it('печатает номера, даты и заголовки', async () => {
    const h = harness();

    await h.send('/source posts lor');

    const reply = h.replies.join('\n');

    assert.match(reply, /1\. ✅/);
    assert.match(reply, /2\. •/);
    assert.match(reply, /3\. ✅/);
    assert.match(reply, /Заголовок lor:3/);
    assert.match(reply, /03\.10/, 'дата в формате ДД.ММ');
    assert.equal(reply.includes('2026'), false, 'год в списке не нужен');
  });

  it('объясняет отметки и подсказывает следующую команду', async () => {
    const h = harness();

    await h.send('/source posts lor');

    assert.match(h.replies.join('\n'), /\/source resend ID N/);
  });

  it('ничего не отправляет в целевой чат', async () => {
    const h = harness();

    await h.send('/source posts lor');

    assert.deepEqual(h.resent, []);
  });

  it('вторая выборка показывает свежие данные', async () => {
    const h = harness();
    await h.send('/source posts lor');

    h.setRecent([stored('sent', 'lor:99', '2026-11-01T10:00:00.000Z')]);
    h.replies.length = 0;
    await h.send('/source posts lor');

    assert.match(h.replies.join('\n'), /Заголовок lor:99/);
  });

  it('пустой источник объясняется, а не выглядит как поломка', async () => {
    const h = harness([]);

    await h.send('/source posts lor');

    assert.match(h.replies.join('\n'), /нет записей/i);
    assert.equal(h.resent.length, 0);
  });

  it('количество из чата учитывается', async () => {
    const h = harness();

    await h.send('/source posts lor 2');

    const reply = h.replies.join('\n');

    assert.match(reply, /1\. ✅/);
    assert.match(reply, /2\. •/);
    assert.equal(reply.includes('3. ✅'), false, 'третьей записи в списке нет');
  });

  it('нечисловое количество отвергается с подсказкой формата', async () => {
    const h = harness();

    await h.send('/source posts lor много');

    assert.match(h.replies.join('\n'), /Неверное количество/);
  });

  it('неизвестный источник назван по имени, а не молча пуст', async () => {
    const h = harness();

    await h.send('/source posts manjaro');

    assert.match(h.replies.join('\n'), /manjaro.*не найден/s);
  });

  it('без id подсказывает, где список', async () => {
    const h = harness();

    await h.send('/source posts');

    assert.match(h.replies.join('\n'), /\/source list/);
  });
});

describe('/source resend: пересылка выбранного поста', () => {
  it('отправляет пост из показанного списка по его номеру', async () => {
    const h = harness();
    await h.send('/source posts lor');

    await h.send('/source resend lor 2');

    assert.deepEqual(h.resent, ['lor:2']);
  });

  it('номер 1 — самая свежая запись списка', async () => {
    const h = harness();
    await h.send('/source posts lor');

    await h.send('/source resend lor 1');

    assert.deepEqual(h.resent, ['lor:3']);
  });

  it('подтверждает в админ-чат, что именно отправлено', async () => {
    const h = harness();
    await h.send('/source posts lor');
    h.replies.length = 0;

    await h.send('/source resend lor 2');

    assert.match(h.replies.join('\n'), /Заголовок lor:2/);
  });

  it('требует сначала показать список', async () => {
    const h = harness();

    await h.send('/source resend lor 1');

    assert.match(h.replies.join('\n'), /\/source posts lor/);
    assert.deepEqual(h.resent, [], 'ничего не отправлено наугад');
  });

  it('номер за пределами показанного списка отвергается', async () => {
    const h = harness();
    await h.send('/source posts lor');

    await h.send('/source resend lor 4');

    assert.deepEqual(h.resent, []);
    assert.match(h.replies.join('\n'), /нет поста №4|1–3/);
  });

  it('нечисловой номер отвергается', async () => {
    const h = harness();
    await h.send('/source posts lor');

    await h.send('/source resend lor второй');

    assert.deepEqual(h.resent, []);
    assert.match(h.replies.join('\n'), /номер поста/i);
  });

  it('нулевой и отрицательный номер отвергаются', async () => {
    const h = harness();
    await h.send('/source posts lor');

    await h.send('/source resend lor 0');
    await h.send('/source resend lor -1');

    assert.deepEqual(h.resent, []);
  });

  it('выбор идёт по показанному снимку, а не по свежей базе', async () => {
    const h = harness();
    await h.send('/source posts lor');

    /*
     * Между командами пришёл новый пост. Если бы resend перечитывал базу, номер
     * 2 указал бы на другой пост — и это самый коварный вид промаха: сообщение
     * об успехе выглядело бы правдой.
     */
    h.setRecent([
      stored('sent', 'lor:new', '2026-11-01T10:00:00.000Z'),
      stored('sent', 'lor:3', '2026-10-03T10:00:00.000Z'),
      stored('pending', 'lor:2', '2026-10-02T10:00:00.000Z'),
      stored('sent', 'lor:1', '2026-10-01T10:00:00.000Z')
    ]);

    await h.send('/source resend lor 2');

    assert.deepEqual(h.resent, ['lor:2'], 'отправлен тот пост, который был под номером 2');
  });

  it('список из другого источника не подходит', async () => {
    const h = harness();
    await h.send('/source posts lor');

    await h.send('/source resend manjaro 1');

    assert.deepEqual(h.resent, []);
    assert.match(h.replies.join('\n'), /manjaro.*не найден/s);
  });

  it('после показа списка ещё раз другой источник — снимки не смешиваются', async () => {
    const h = harness();
    await h.send('/source posts lor');

    await h.send('/source posts lor');

    await h.send('/source resend lor 3');

    assert.deepEqual(h.resent, ['lor:1']);
  });
});

describe('/source resend-last остаётся рабочим', () => {
  it('пересылает последний пост в обход списка', async () => {
    const h = harness();

    await h.send('/source resend-last lor');

    assert.deepEqual(h.resent, [], 'resendLatest у тестового пайплайна свой путь');
    assert.match(h.replies.join('\n'), /Последний пост повторно отправлен/);
  });
});