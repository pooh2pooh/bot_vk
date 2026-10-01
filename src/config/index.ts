import type { AppConfig } from './app-config.js';
import { loadEnv } from './env.js';
import { loadSources } from './sources-loader.js';

/**
 * Сборка конфигурации приложения — единственное место, где `.env`
 * превращается в типизированный объект.
 */
export async function loadConfig(): Promise<AppConfig> {
  const env = loadEnv();
  const sources = await loadSources(env.SOURCES_FILE);

  return {
    vkToken: env.VK_TOKEN,
    targetChat: env.TARGET_CHAT,
    adminChat: env.ADMIN_CHAT,
    ownerId: env.OWNER_ID,

    sources,

    userAgent: env.USER_AGENT,
    maxParallelPageRequests: env.MAX_PARALLEL_PAGE_REQUESTS,
    pageCacheSize: env.PAGE_CACHE_SIZE,

    logLevel: env.LOG_LEVEL,

    imageDownloadTimeoutMs: env.IMAGE_DOWNLOAD_TIMEOUT_MS,
    vkUploadTimeoutMs: env.VK_UPLOAD_TIMEOUT_MS,

    openRouter: env.OPENROUTER_API_KEY
      ? {
          apiKey: env.OPENROUTER_API_KEY,
          model: env.OPENROUTER_MODEL,
          modelName: env.OPENROUTER_MODEL_NAME,
          timeoutMs: env.OPENROUTER_TIMEOUT_MS,
          maxTokens: env.OPENROUTER_MAX_TOKENS,
          maxAttempts: env.OPENROUTER_MAX_ATTEMPTS,
          retryDelayMs: env.OPENROUTER_RETRY_DELAY_MS
        }
      : null,

    databasePath: env.DATABASE_PATH
  };
}

export type { AppConfig } from './app-config.js';
export type { SourceConfig } from './source-config.js';