import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function numberEnv(
  name: string,
  fallback: number
): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Invalid number in ${name}: ${value}`
    );
  }

  return parsed;
}

export const config = {
  vkToken: required('VK_TOKEN'),

  targetChat: numberEnv(
    'TARGET_CHAT',
    2000000002
  ),
  adminChat: numberEnv(
    'ADMIN_CHAT',
    2000000003
  ),
  ownerId: numberEnv(
    'OWNER_ID',
    281457599
  ),

  feedUrl:
    process.env.FEED_URL ??
    'https://manjaro.ru/atom',

  screenshotFeedUrl:
    process.env.SCREENSHOTS_FEED_URL ??
    'https://www.linux.org.ru/section-rss.jsp?section=3',

  pollIntervalMs: numberEnv(
    'POLL_INTERVAL_MS',
    60_000
  ),
  requestTimeoutMs: numberEnv(
    'REQUEST_TIMEOUT_MS',
    30_000
  ),
  imageDownloadTimeoutMs: numberEnv(
    'IMAGE_DOWNLOAD_TIMEOUT_MS',
    60_000
  ),
  vkUploadTimeoutMs: numberEnv(
    'VK_UPLOAD_TIMEOUT_MS',
    90_000
  ),

  logLevel: process.env.LOG_LEVEL ?? 'info',

  openRouterApiKey: required(
    'OPENROUTER_API_KEY'
  ),
  openRouterModel:
    process.env.OPENROUTER_MODEL ??
    'z-ai/glm-5.2:free',
  openRouterModelName:
    process.env.OPENROUTER_MODEL_NAME ??
    'GLM 5.2',
  openRouterPromptPath:
    process.env.OPENROUTER_PROMPT_FILE ??
    'templates/ai_comment.txt',
  openRouterTimeoutMs: numberEnv(
    'OPENROUTER_TIMEOUT_MS',
    30_000
  ),
  openRouterMaxTokens: numberEnv(
    'OPENROUTER_MAX_TOKENS',
    300
  ),

  databasePath: 'data/bot.db',
  templatesPath: 'templates'
} as const;
