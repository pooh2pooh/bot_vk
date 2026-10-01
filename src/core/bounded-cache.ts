/**
 * Кеш ограниченного размера с вытеснением в порядке вставки (FIFO).
 *
 * Нужен всем, кто ходит на страницы постов: посты не меняются после публикации,
 * поэтому разбирать страницу второй раз незачем, а держать бесконечно много
 * разобранного HTML нельзя.
 *
 * Именно FIFO, а не LRU: порядок вставки в Map совпадает с порядком
 * добавления, поэтому самый старый ключ находится за O(1) без обхода. Для
 * постов, которые больше не меняются, разница между FIFO и LRU на практике
 * не видна.
 *
 * Размер задаётся один раз в конструкторе: ноль и отрицательное значение
 * означают «не кешировать», и это валидная конфигурация.
 */
export class BoundedCache<V> {
  private readonly items = new Map<string, V>();

  private readonly enabled: boolean;

  constructor(private readonly maxSize: number) {
    this.enabled = maxSize > 0;
  }

  get(key: string): V | undefined {
    return this.items.get(key);
  }

  set(key: string, value: V): void {
    if (!this.enabled) {
      return;
    }

    // Повторная запись на существующий ключ обязана обновить позицию вставки,
    // иначе «старейшим» окажется ключ, который на самом деле новый.
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