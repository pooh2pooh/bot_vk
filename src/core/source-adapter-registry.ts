import { Registry } from './registry.js';
import type { SourceAdapter } from './source-adapter.js';

/**
 * Минимальный контракт, который реестру нужно знать о конфиге источника.
 *
 * Реестр параметризован типом конфига (`SourceConfig` передаёт его
 * registries.ts), поэтому core/ не зависит от слоя config/ — достаточно
 * знать, где лежит ключ `type` и id для сообщения об ошибке.
 */
export interface SourceDescriptor {
  /** Ключ адаптера в этом реестре. */
  type: string;
  /** Id источника — нужен только для понятного сообщения об ошибке. */
  id: string;
}

export type SourceAdapterFactory<TConfig> = (config: TConfig) => SourceAdapter;

/**
 * Реестр типов источников. Чтобы добавить принципиально новый тип
 * (не RSS/Atom — например, Telegram-канал через MTProto/Bot API),
 * нужно реализовать SourceAdapter и зарегистрировать фабрику здесь
 * под новым `type`. Остальной конвейер (дедупликация, шаблоны,
 * отправка, backoff, команды) не меняется.
 */
export class SourceAdapterRegistry<TConfig extends SourceDescriptor>
  extends Registry<SourceAdapterFactory<TConfig>>
{
  protected readonly kind = 'source type';

  create(config: TConfig): SourceAdapter {
    return this.require(
      config.type,
      `for source "${config.id}"`
    )(config);
  }
}
