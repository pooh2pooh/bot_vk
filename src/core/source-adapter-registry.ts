import type { SourceConfig } from '../config/source-config.js';
import type { SourceAdapter } from './source-adapter.js';

export type SourceAdapterFactory = (config: SourceConfig) => SourceAdapter;

/**
 * Реестр типов источников. Чтобы добавить принципиально новый тип
 * (не RSS/Atom — например, Telegram-канал через MTProto/Bot API),
 * нужно реализовать SourceAdapter и зарегистрировать фабрику здесь
 * под новым `type`. Остальной конвейер (дедупликация, шаблоны,
 * отправка, backoff, команды) не меняется.
 */
export class SourceAdapterRegistry {
  private readonly factories = new Map<string, SourceAdapterFactory>();

  register(type: string, factory: SourceAdapterFactory): void {
    this.factories.set(type, factory);
  }

  create(config: SourceConfig): SourceAdapter {
    const factory = this.factories.get(config.type);

    if (!factory) {
      throw new Error(
        `Unknown source type "${config.type}" for source "${config.id}". ` +
          `Registered: ${[...this.factories.keys()].join(', ')}`
      );
    }

    return factory(config);
  }
}
