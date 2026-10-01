/**
 * Что бот отправляет в сообщении.
 *
 * - `feed`     — текст из фида, укороченный до `textLimit` по границе слова;
 * - `feedFull` — весь текст из фида как есть;
 * - `generated` — текст, сгенерированный по промпту источника (AI).
 *
 * Для `generated` действует fallback-стандарт: если генерация не удалась,
 * отправляется укороченный текст фида, то же, что и в режиме `feed`.
 *
 * Названия намеренно про `источник текста`, а не про `длину`: длина задаётся
 * отдельно полем `textLimit` и режимом не определяется.
 */
export type TextMode = 'feed' | 'feedFull' | 'generated';

export const TEXT_MODES: readonly TextMode[] = ['feed', 'feedFull', 'generated'];

export function isTextMode(value: unknown): value is TextMode {
  return TEXT_MODES.includes(value as TextMode);
}