import type { FeedEntry } from './types.js';

/**
 * Единственная точка входа для получения новых записей источника.
 * Всё остальное (дедупликация, обогащение, шаблоны, отправка, backoff)
 * — общий конвейер, не завязанный на конкретный сайт.
 *
 * Новый ТИП источника (не RSS/Atom, например Telegram-канал или Reddit)
 * реализуется этим интерфейсом и регистрируется в SourceAdapterRegistry
 * под новым ключом `type`. Остальной код не меняется.
 */
export interface SourceAdapter {
  readonly sourceId: string;
  fetch(): Promise<FeedEntry[]>;
}
