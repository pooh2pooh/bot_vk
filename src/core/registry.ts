/**
 * База для всех реестров подключаемых стратегий (тип источника, экстрактор
 * картинок, способ обогащения, экстрактор описания).
 *
 * Даёт общее поведение: регистрация по строковому ключу, проверка наличия и
 * единообразная ошибка со списком зарегистрированных ключей. Наследники
 * добавляют только то, что специфично для их роли.
 */
export abstract class Registry<V> {
  private readonly items = new Map<string, V>();

  /** Имя сущности для сообщения об ошибке, например `imageExtractor`. */
  protected abstract readonly kind: string;

  register(key: string, value: V): void {
    this.items.set(key, value);
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  keys(): string[] {
    return [...this.items.keys()];
  }

  /**
   * Возвращает значение по ключу либо бросает ошибку, перечисляющую все
   * зарегистрированные ключи — чтобы в логе сразу было видно, что доступно.
   */
  protected require(key: string, context = ''): V {
    const value = this.items.get(key);

    if (!value) {
      const suffix = context ? ` ${context}` : '';

      throw new Error(
        `Unknown ${this.kind} "${key}"${suffix}. ` +
          `Registered: ${this.keys().join(', ')}`
      );
    }

    return value;
  }
}
