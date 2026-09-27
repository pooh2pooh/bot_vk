/**
 * Декларативное описание одного источника из config/sources.yml.
 * Добавление/удаление/настройка источника = правка YAML, без кода,
 * пока используются уже зарегистрированные type/imageExtractor/enrich.
 */
export interface SourceConfig {
  /** Уникальный id источника. Используется в БД, командах, логах. */
  id: string;
  /** Человекочитаемое имя для логов и команд. */
  name: string;
  /** Тип адаптера: сейчас 'rss', см. SourceAdapterRegistry. */
  type: string;
  /** Включён ли источник (можно переключать также командой /source). */
  enabled: boolean;
  /** URL RSS/Atom-фида. */
  url: string;
  /** Требовать ли хотя бы одну картинку, иначе запись пропускается. */
  requireImages: boolean;
  /** Ключ стратегии извлечения картинок, см. ImageExtractorRegistry. */
  imageExtractor: string;
  /** Ключ стратегии обогащения (AI и т.п.), см. EnricherRegistry. */
  enrich: string;
  /** Путь к YAML-шаблону сообщения для этого источника. */
  template: string;
  /** Интервал опроса, мс. Если не задан — берётся глобальный дефолт. */
  pollIntervalMs?: number;
  /** Timeout HTTP-запроса фида, мс. Если не задан — глобальный дефолт. */
  requestTimeoutMs?: number;
  /** Опциональный override пути промпта для enrich: openrouter. */
  promptPath?: string;
}
