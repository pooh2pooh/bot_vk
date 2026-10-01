import { Registry } from './registry.js';
import type { PageContext } from './page-based-site.js';
import { PLAIN_SITE_STRATEGY, type SiteStrategy } from './site-strategy.js';

/**
 * Стратегия создаётся функцией, а не хранится готовым объектом: у каждого
 * источника свои таймаут и свой кеш разобранных страниц.
 */
export type SiteStrategyFactory = (ctx: PageContext) => SiteStrategy;

/**
 * Реестр стратегий сайтов.
 *
 * Ключ — `site` из `config/sources.yml`. Один ключ регистрирует сайт целиком:
 * и разбор картинок, и чистку описания, и догрузку страницы поста.
 *
 * Добавить сайт = реализовать `SiteStrategy` и зарегистрировать его здесь одной
 * строкой. Больше нигде упоминать этот сайт не нужно: ни в `index.ts`, ни в
 * пайплайне, ни в конфиге по ключам.
 */
export class SiteStrategyRegistry extends Registry<SiteStrategyFactory> {
  protected readonly kind = 'site';

  constructor() {
    super();
    this.register('none', () => PLAIN_SITE_STRATEGY);
  }

  /** Создаёт стратегию для конкретного источника. */
  create(key: string | undefined, ctx: PageContext): SiteStrategy {
    return this.require(key ?? 'none')(ctx);
  }
}