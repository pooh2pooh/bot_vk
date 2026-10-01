import type { StoredEntry } from '../db/database.js';
import { truncateText } from '../core/text.js';

/** Сколько записей показывает список без аргумента. */
export const DEFAULT_LIST_LIMIT = 10;

/** Потолок списка: длиннее сообщение в VK всё равно не пропустить. */
export const MAX_LIST_LIMIT = 20;

const TITLE_LIMIT = 70;

/** Отметка состояния записи — заметно глазом, без чтения даты и id. */
const STATE_MARKS = {
  sent: '✅',
  skipped: '⏭',
  pending: '•'
} as const;

/**
 * Сколько записей показать.
 *
 * Значение приходит из чата, поэтому проверяется строго: молчаливый дефолт на
 * месте кривой цифры отвечал бы «вот эти 10 постов» на вопрос про 20-е число,
 * и промах был бы незаметен.
 */
export function parseListLimit(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_LIST_LIMIT;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`Неверное количество: "${value}". Пример: /source posts ID 10`);
  }

  const limit = Number(value);

  if (limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`Количество должно быть от 1 до ${MAX_LIST_LIMIT}.`);
  }

  return limit;
}

/**
 * Дата поста в компактном виде: `01.10 16:04`.
 *
 * Год пропущен намеренно: список смотрит человек, у которого посты свежие, а
 * колонка года в мобильном чате съедала бы ширину строки целиком.
 */
function formatDate(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return 'дата неизвестна';
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${day}.${month} ${hours}:${minutes}`;
}

/**
 * Список постов источника, готовый к отправке в чат.
 *
 * Номер в первой колонке — это и есть аргумент для `/source resend`, поэтому
 * он печатается всегда, даже когда запись всего одна.
 */
export function formatEntryList(entries: StoredEntry[]): string[] {
  const lines: string[] = [];

  for (const [index, stored] of entries.entries()) {
    const { entry, state } = stored;
    const mark = STATE_MARKS[state];
    const images = entry.imageUrls.length > 0 ? ` 🖼${entry.imageUrls.length}` : '';
    const title = oneLine(truncateText(entry.title, TITLE_LIMIT));

    lines.push(`${index + 1}. ${mark} ${formatDate(entry.published)}${images}`);

    // Отступ табуляцией: виден в моноширинном виде и не съедает пробелы,
    // которые тест проверяет на обрезание заголовка.
    lines.push(`\t${title}`);
  }

  return lines;
}

/**
 * Заголовок в одну строку.
 *
 * Перевод строки внутри заголовка сдвинул бы вторую строку записи на вид
 * самостоятельного пункта, а следующий номер — на нечётное место в списке.
 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Подпись под списком: что означает отметка и что делать дальше.
 *
 * Отдельной строкой, а не в каждой записи: повторённая трижды расшифровка
 * занимает больше места, чем сама расшифровка.
 */
export function formatListFooter(entries: StoredEntry[]): string {
  const skipped = entries.filter(stored => stored.state === 'skipped').length;

  const details = [
    `${STATE_MARKS.sent} отправлен`,
    skipped > 0 ? `${STATE_MARKS.skipped} пропущен при первом запуске` : '',
    `${STATE_MARKS.pending} ещё не отправлен`
  ].filter(Boolean);

  return (
    `${details.join(' · ')}\n` +
    `Переслать: /source resend ID N, где N — номер в списке.`
  );
}