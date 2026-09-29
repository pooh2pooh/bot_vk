/**
 * Разбор HTML по блокам — общий для всех экстракторов, которые ходят на
 * страницу поста.
 *
 * Живёт в core/, потому что не знает ни про LOR, ни про pingvinus: это просто
 * умение найти вёрстку нужного кусочка страницы. Знание сайта (какой класс
 * искать, какой блок выкинуть) остаётся в экстракторах.
 *
 * Регулярки вместо DOM-парсера — осознанный выбор: страница целиком не нужна,
 * нужен один контейнер, а полноценный парсер в проект не вносили бы. Все
 * функции работают на Позициях в исходной строке и ничего не копируют.
 */

/** Позиция открывающего тега с указанным именем, либо -1. */
export function findTag(html: string, name: string): number {
  const match = new RegExp(`<${name}\\b[^>]*>`, 'i').exec(html);
  return match ? match.index : -1;
}

/**
 * Позиция первого элемента, в атрибуте class которого встречается
 * `className` как ОТДЕЛЬНОЕ слово.
 *
 * Сравнение по словам, а не подстроке: иначе класс `text` нашёлся бы внутри
 * `context-text` и мы бы вырезали чужой блок.
 */
export function findElementByClass(html: string, className: string): number {
  const tagPattern =
    /<div\b[^>]*?\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

  const wanted = new Set(className.split(/\s+/));
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html))) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';

    if (value.split(/\s+/).some(word => wanted.has(word))) {
      return match.index;
    }
  }

  return -1;
}

/**
 * Сбалансированный блок `<name>…</name>`, начинающийся в позиции `start`.
 *
 * Имя парного тега берётся из самого `start`, а не задаётся аргументом: блок
 * может начинаться с `<article>`, а счётчик вложенности обязан считать ровно
 * его. Если задать имя заранее (например, всегда `div`), счётчик начнёт с
 * нуля на `<article>` и граница блока уедет до конца страницы.
 */
export function balancedElement(html: string, start: number): string {
  const opening = /^<([a-z0-9-]+)\b[^>]*>/i.exec(
    html.slice(start, start + 200)
  );

  if (!opening?.[1]) {
    return '';
  }

  const name = opening[1];
  const tagPattern = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
  tagPattern.lastIndex = start;

  let depth = 0;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html))) {
    depth += match[1] === '/' ? -1 : 1;

    if (depth === 0) {
      return html.slice(start, match.index + match[0].length);
    }
  }

  // Незакрытый блок: отдаём остаток разметки, фильтры экстрактора всё равно
  // отсеют лишнее по домену и пути.
  return html.slice(start);
}

/** Внутренность блока с заданным классом, без его внешней обёртки. */
export function innerBlockByClass(
  html: string,
  className: string
): string | null {
  const start = findElementByClass(html, className);

  if (start === -1) {
    return null;
  }

  const block = balancedElement(html, start);
  const openEnd = block.indexOf('>');
  const closeStart = block.lastIndexOf('</div>');

  if (openEnd === -1 || closeStart === -1) {
    return null;
  }

  return block.slice(openEnd + 1, closeStart);
}

/**
 * Область, в которой искать содержимое поста.
 *
 * Это <article>, если он есть на странице, иначе вся разметка. Ограничение
 * принципиально: в сайдбаре и подвале встречаются блоки с теми же классами,
 * что и у поста, и «первый попавшийся» почти всегда оказывался бы чужим.
 * Отдельный случай — <article> на странице один, поэтому искать его надёжно.
 */
export function postScope(html: string): string {
  const start = findTag(html, 'article');
  return start === -1 ? html : balancedElement(html, start);
}
