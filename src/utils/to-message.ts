/**
 * Приводит произвольное значение к строке сообщения об ошибке.
 *
 * Раньше выражение `error instanceof Error ? error.message : String(error)`
 * повторялось почти в каждом catch. Здесь оно живёт в одном месте, а заодно
 * обрезаются лишние пробелы — иначе одинаковые по сути ошибки давали разные
 * строки и ломали дедупликацию в ErrorBackoff.
 */
export function toMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error);

  return message.trim();
}
