import type { AppConfig } from './app-config.js';
import { loadEnv } from './env.js';
import { loadSources } from './sources-loader.js';

export async function loadConfig(): Promise<AppConfig> {
  const env = loadEnv();
  const sources = await loadSources(env.SOURCES_FILE);

  return {
    vkToken: env.VK_TOKEN,
    targetChat: env.TARGET_CHAT,
    adminChat: env.ADMIN_CHAT,
    ownerId: env.OWNER_ID,

    sources,

    defaultPollIntervalMs: env.DEFAULT_POLL_INTERVAL_MS,
    defaultRequestTimeoutMs: env.DEFAULT_REQUEST_TIMEOUT_MS,
    userAgent: env.USER_AGENT,

    logLevel: env.LOG_LEVEL,

    imageDownloadTimeoutMs: env.IMAGE_DOWNLOAD_TIMEOUT_MS,
    vkUploadTimeoutMs: env.VK_UPLOAD_TIMEOUT_MS,

    openRouter: env.OPENROUTER_API_KEY
      ? {
          apiKey: env.OPENROUTER_API_KEY,
          model: env.OPENROUTER_MODEL,
          modelName: env.OPENROUTER_MODEL_NAME,
          promptPath: env.OPENROUTER_PROMPT_FILE,
          timeoutMs: env.OPENROUTER_TIMEOUT_MS,
          maxTokens: env.OPENROUTER_MAX_TOKENS
        }
      : null,

    databasePath: env.DATABASE_PATH
  };
}

export type { AppConfig } from './app-config.js';
export type { SourceConfig } from './source-config.js';
