import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorBackoff } from '../utils/error-backoff.js';
import { toMessage } from '../utils/to-message.js';

const MINUTE = 60_000;

/** Задокументированная лестница задержек: 3 -> 6 -> 12 -> 40 -> 60 мин. */
const EXPECTED_DELAYS = [
  3 * MINUTE,
  6 * MINUTE,
  12 * MINUTE,
  40 * MINUTE,
  60 * MINUTE
];

describe('ErrorBackoff', () => {
  it('первая ошибка даёт минимальную задержку и логируется', () => {
    const result = new ErrorBackoff().fail(new Error('boom'));

    assert.equal(result.count, 1);
    assert.equal(result.delayMs, EXPECTED_DELAYS[0]);
    assert.equal(result.shouldLog, true);
  });

  it('одинаковые ошибки подряд повышают задержку по лестнице', () => {
    const backoff = new ErrorBackoff();
    const delays = EXPECTED_DELAYS.map(() => backoff.fail('boom').delayMs);

    assert.deepEqual(delays, EXPECTED_DELAYS);
  });

  it('после 5-й ошибки задержка больше не растёт', () => {
    const backoff = new ErrorBackoff();

    for (let i = 0; i < 10; i++) {
      backoff.fail('boom');
    }

    const result = backoff.fail('boom');

    assert.equal(result.count, 11);
    assert.equal(result.delayMs, EXPECTED_DELAYS[4]);
  });

  it('логирует только первую из одинаковых ошибок', () => {
    const backoff = new ErrorBackoff();
    const shouldLog = [1, 2, 3].map(() => backoff.fail('boom').shouldLog);

    assert.deepEqual(shouldLog, [true, false, false]);
  });

  it('другая ошибка сбрасывает счётчик и снова логируется', () => {
    const backoff = new ErrorBackoff();
    backoff.fail('boom');
    backoff.fail('boom');

    const result = backoff.fail('совсем другая');

    assert.equal(result.count, 1);
    assert.equal(result.delayMs, EXPECTED_DELAYS[0]);
    assert.equal(result.shouldLog, true);
  });

  it('success() сообщает о восстановлении и сбрасывает состояние', () => {
    const backoff = new ErrorBackoff();
    backoff.fail('boom');
    backoff.fail('boom');

    const recovery = backoff.success();

    assert.deepEqual(recovery, { hadFailures: true, count: 2 });
    assert.equal(backoff.fail('boom').count, 1);
  });

  it('success() без предшествующих ошибок не считается восстановлением', () => {
    assert.deepEqual(new ErrorBackoff().success(), {
      hadFailures: false,
      count: 0
    });
  });

  it('ошибки одинаковые по сути считаются одной и той же (trim)', () => {
    const backoff = new ErrorBackoff();
    backoff.fail(new Error('  connection reset  '));

    const result = backoff.fail(new Error('connection reset'));

    assert.equal(result.count, 2);
    assert.equal(result.shouldLog, false);
  });

  it('принимает не-Error значения без падения', () => {
    const backoff = new ErrorBackoff();

    assert.equal(backoff.fail('строка').count, 1);
    assert.equal(backoff.fail('строка').count, 2);
  });
});

describe('toMessage', () => {
  it('берёт message у Error', () => {
    assert.equal(toMessage(new Error('что-то сломалось')), 'что-то сломалось');
  });

  it('принимает строку и обрезает пробелы', () => {
    assert.equal(toMessage('  необработанная ошибка \n'), 'необработанная ошибка');
  });

  it('обрезает пробелы у Error', () => {
    assert.equal(toMessage(new Error('  padded  ')), 'padded');
  });

  it('не падает на прочих значениях', () => {
    assert.equal(toMessage(42), '42');
    assert.equal(toMessage(null), 'null');
    assert.equal(toMessage(undefined), 'undefined');
  });
});
