/**
 * Кеш ограниченного размера с вытеснением в порядке вставки.
 *
 * Нужен всем, кто ходит на страницы постов: посты не меняются после публикации,
 * поэтому разбирать страницу второй раз незачем, а держать бесконечно много
 * разобранных HTML нельзя.
 *
 * Именно «в порядке вставки» (FIFO), а не по последнему обращению: порядок
 * вставки в Map совпадает с порядком добавления, поэтому самый старый ключ
 * находится за O(1) без обхода. Для постов, которые больше не меняются,
 * разницы между FIFO и LRU практически нет.
 */
export class BoundedCache<V> {
  private readonly items = new Map<string, V>();

  /** `maxSize <= 0` отключает кеш: значение не сохраняется, но и не падает. */
  constructor(private readonly maxSize: number) {}

  get(key: string): V | undefined {
    return this.items.get(key);
  }

  set(key: string, value: V): void {
    if (this.maxSize <= 0) {
      return;
    }

    this.items.delete(key);

    while (this.items.size >= this.maxSize) {
      const oldest = this.items.keys().next().value;

      if (oldest === undefined) {
        break;
      }

      this.items.delete(oldest);
    }

    this.items.set(key, value);
  }

  get size(): number {
    return this.items.size;
  }
}
