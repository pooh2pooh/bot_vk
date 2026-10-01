import type { SourceConfig } from './source-config.js';

/** Настройки доступа к OpenRouter. Секрет берётся из `.env`. */
export interface OpenRouterConfig {
  apiKey: string;
  /** Технический идентификатор модели, например `z-ai/glm-5.2:free`. */
  model: string;
  /** Имя модели для подписи в сообщении: технический идентификатор людям не нужен. */
  modelName: string;
  timeoutMs: number;
  maxTokens: number;
  /** Попыток на один запрос при временном сбое; 1 — без повторов. */
  maxAttempts: number;
  /** Задержка перед повтором, если сервер не прислал `Retry-After`. */
  retryDelayMs: number;
}

/**
 * Конфигурация приложения: `.env` + `config/sources.yml`, уже приведённые к
 * типам и провалидированные.
 *
 * Сборка ровно в одном месте (`config/index.ts`) — чтобы нельзя было получить
 * два разных представления одних и тех же настроек.
 */
export interface AppConfig {
  /** Токен сообщества VK с правами на сообщения. */
  vkToken: string;
  /** Куда постить. */
  targetChat: number;
  /** Куда слать отчёты об ошибках. */
  adminChat: number;
  /** Кому доступны административные команды. */
  ownerId: number;

  /** Источники из config/sources.yml. */
  sources: SourceConfig[];

  /** User-Agent для всех HTTP-запросов. */
  userAgent: string;
  /** Потолок одновременных загрузок страниц постов одного источника. */
  maxParallelPageRequests: number;
  /** Сколько разобранных страниц постов держит стратегия сайта в памяти. */
  pageCacheSize: number;

  logLevel: 'debug' | 'info' | 'warn' | 'error';

  imageDownloadTimeoutMs: number;
  vkUploadTimeoutMs: number;

  /** null, если OPENROUTER_API_KEY не задан: тогда `enrich: openrouter` недоступен. */
  openRouter: OpenRouterConfig | null;

  databasePath: string;
}