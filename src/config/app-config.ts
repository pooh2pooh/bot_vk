import type { SourceConfig } from './source-config.js';

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  modelName: string;
  promptPath: string;
  timeoutMs: number;
  maxTokens: number;
}

export interface AppConfig {
  vkToken: string;
  targetChat: number;
  adminChat: number;
  ownerId: number;

  sources: SourceConfig[];

  defaultPollIntervalMs: number;
  defaultRequestTimeoutMs: number;
  userAgent: string;

  logLevel: 'debug' | 'info' | 'warn' | 'error';

  imageDownloadTimeoutMs: number;
  vkUploadTimeoutMs: number;

  /** null, если OPENROUTER_API_KEY не задан — тогда enrich: openrouter недоступен. */
  openRouter: OpenRouterConfig | null;

  databasePath: string;
}
