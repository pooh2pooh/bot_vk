/**
 * Фильтры конфигурации: шаблоны, которые отбирают записи источника.
 *
 * Один модуль на оба фильтра (`includeFilter` по заголовку и `generateWhen`
 * по заголовку же) — потому что работают они одинаково и различаются только
 * тем, кто вызывает их.
 *
 * Правило проверки общее и неочевидное, поэтому зафиксировано здесь: проверяется
 * ЗАГОЛОВОК ЦЕЛИКОМ, а не как часть текста. Шаблон `^\[Stable Update\]`
 * на склеенном «заголовок + описание» не сработал бы никогда, потому что `^`
 * привязан к началу строки, а не к началу подстроки.
 */
export interface Filter {
  /** Сам шаблон — для сообщений об ошибках и логов. */
  readonly pattern: RegExp;
  readonly source: string;
  /** Проверяет, подходит ли заголовок. */
  matches(title: string): boolean;
}

/**
 * Компилирует шаблон из конфигурации.
 *
 * Флаги намеренно не добавляются: в JavaScript `^` и `$` привязаны ко всей
 * строке, а не к строкам текста, поэтому дополнительные флаги (`m`, `s`) не
 * нужны и только меняли бы смысл шаблона неочевидным образом.
 *
 * Ошибка компиляции превращается в сообщение с именем поля и источником: иначе
 * опечатка в YAML выглядит как «источник молча отдаёт пустоту».
 */
export function compileFilter(pattern: string, source: string): Filter {
  let compiled: RegExp;

  try {
    compiled = new RegExp(pattern);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new Error(
      `Invalid filter in ${source}: /${pattern}/ — ${reason}`
    );
  }

  return {
    pattern: compiled,
    source,
    matches: title => compiled.test(title)
  };
}