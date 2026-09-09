import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number in ${name}: ${value}`);
  }

  return parsed;
}

export const config = {
  vkToken: required('VK_TOKEN'),

  targetChat: numberEnv('TARGET_CHAT', 2000000003),
  adminChat: numberEnv('ADMIN_CHAT', 2000000002),
  ownerId: numberEnv('OWNER_ID', 281457599),

  feedUrl: process.env.FEED_URL ?? 'https://manjaro.ru/atom',

  pollIntervalMs: numberEnv('POLL_INTERVAL_MS', 60_000),
  requestTimeoutMs: numberEnv('REQUEST_TIMEOUT_MS', 15_000),

  logLevel: process.env.LOG_LEVEL ?? 'info',

  databasePath: 'data/bot.db',
  templatesPath: 'templates'
} as const;
