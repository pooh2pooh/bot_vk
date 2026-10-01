/**
 * Список постов для `/source posts` и его разбор: `/source resend ID N`.
 *
 * Номера в списке — это то, что админ вводит следующей командой, поэтому
 * проверяются и разметка, и отказ на кривом номере: молчаливый дефолт на месте
 * чужого ввода отправил бы не тот пост.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeedEntry } from '../core/types.js';
import type { EntryState, StoredEntry } from '../db/database.js';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  formatEntryList,
  formatListFooter,
  parseListLimit
} from '../commands/source-entries.js';

function entry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: 'lor:1',
    sourceId: 'lor',
    title: 'Заголовок поста',
    link: 'https://www.linux.org.ru/news/1',
    author: 'Автор',
    content: 'Текст поста',
    published: '2026-10-01T16:04:00.000Z',
    updated: '2026-10-01T16:04:00.000Z',
    imageUrls: [],
    ...overrides
  };
}

function stored(state: EntryState, overrides: Partial<FeedEntry> = {}): StoredEntry {
  return { entry: entry(overrides), state };
}

/** Первая строка списка: с проверкой, что список вообще непуст. */
function firstLine(lines: string[]): string {
  const line = lines[0];

  assert.ok(line !== undefined, 'ожидалась хотя бы одна строка списка');

  return line;
}

describe('parseListLimit', () => {
  it('без аргумента берётся дефолт', () => {
    assert.equal(parseListLimit(undefined), DEFAULT_LIST_LIMIT);
  });

  it('число из чата принимается', () => {
    assert.equal(parseListLimit('5'), 5);
    assert.equal(parseListLimit(String(MAX_LIST_LIMIT)), MAX_LIST_LIMIT);
  });

  it('не число отвергается, а не превращается в дефолт', () => {
    for (const value of ['abc', '1.5', '-3', '10 постов', '', ' ']) {
      assert.throws(() => parseListLimit(value), /Неверное количество|от 1 до/);
    }
  });

  it('ноль и слишком большое число отвергаются', () => {
    assert.throws(() => parseListLimit('0'), /от 1 до 20/);
    assert.throws(() => parseListLimit(String(MAX_LIST_LIMIT + 1)), /от 1 до 20/);
  });
});

describe('formatEntryList', () => {
  it('нумерует записи по порядку, начиная с 1', () => {
    const lines = formatEntryList([
      stored('sent', { title: 'Первый' }),
      stored('pending', { title: 'Второй' }),
      stored('sent', { title: 'Третий' })
    ]);

    assert.equal(lines.length, 6, 'одна запись — две строки');
    assert.match(lines[0] ?? '', /^1\./);
    assert.match(lines[2] ?? '', /^2\./);
    assert.match(lines[4] ?? '', /^3\./);
  });

  it('отмечает состояние записи', () => {
    const sent = firstLine(formatEntryList([stored('sent')]));
    const skipped = firstLine(formatEntryList([stored('skipped')]));
    const pending = firstLine(formatEntryList([stored('pending')]));

    assert.match(sent, /✅/);
    assert.match(skipped, /⏭/);
    assert.match(pending, /•/);
  });

  it('одиночная запись всё равно получает номер', () => {
    const line = firstLine(formatEntryList([stored('sent')]));

    assert.match(line, /^1\./);
  });

  it('показывает дату в компактном виде', () => {
    const line = firstLine(
      formatEntryList([stored('sent', { published: '2026-10-01T16:04:00.000Z' })])
    );

    assert.match(line, /\d{2}\.\d{2} \d{2}:\d{2}/);
    assert.equal(line.includes('2026'), false, 'год не занимает место в строке');
  });

  it('битая дата не роняет список', () => {
    const line = firstLine(formatEntryList([stored('sent', { published: 'не дата' })]));

    assert.match(line, /дата неизвестна/);
    assert.match(line, /^1\./, 'запись осталась в списке и под номером');
  });

  it('количество картинок видно, когда их есть', () => {
    const withImages = firstLine(
      formatEntryList([stored('sent', { imageUrls: ['a.png', 'b.png'] })])
    );
    const withoutImages = firstLine(formatEntryList([stored('sent')]));

    assert.match(withImages, /🖼2/);
    assert.equal(withoutImages.includes('🖼'), false, 'нет лишнего символа');
  });

  it('длинный заголовок обрезается по границе слова', () => {
    const long = 'слово '.repeat(40);
    const lines = formatEntryList([stored('sent', { title: long })]);
    const title = (lines[1] ?? '').trim();

    assert.ok(title.length > 0, 'вторая строка с заголовком есть');
    assert.equal(title.includes('  '), false, 'подряд идущих пробелов нет');
    assert.ok(title.endsWith('…'), 'обрезка помечена многоточием');
    assert.ok(title.length <= 72, `заголовок укорочен: ${title.length}`);
  });

  it('переводы строк в заголовке не ломают нумерацию', () => {
    const lines = formatEntryList([stored('sent', { title: 'Первая\nвторая' })]);

    assert.equal(lines.length, 2, 'запись с переводом строки всё равно одна');
    assert.match(lines[0] ?? '', /^1\./);
  });

  it('пустой список даёт пустые строки', () => {
    assert.deepEqual(formatEntryList([]), []);
  });
});

describe('formatListFooter', () => {
  it('объясняет отметки и подсказывает следующую команду', () => {
    const footer = formatListFooter([stored('sent'), stored('pending')]);

    assert.match(footer, /✅ отправлен/);
    assert.match(footer, /• ещё не отправлен/);
    assert.match(footer, /\/source resend ID N/);
  });

  it('про пропущенные говорит только когда они есть', () => {
    assert.equal(
      formatListFooter([stored('sent')]).includes('⏭'),
      false,
      'лишняя расшифровка отметки занимает место'
    );
    assert.match(
      formatListFooter([stored('skipped')]),
      /⏭ пропущен при первом запуске/
    );
  });
});