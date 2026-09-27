import 'dotenv/config';

/**
 * .env хранит только секреты и глобальные дефолты. Настройки конкретных
 * источников (URL, интервалы, шаблоны, enrich) живут в config/sources.yml —
 * это несекретная информация, и её удобнее версионировать и ревьюить diff'ом.
 */
export interface Env {
  VK_TOKEN: string;
  TARGET_CHAT: number;
  ADMIN_CHAT: number;
  OWNER_ID: number;

  DEFAULT_POLL_INTERVAL_MS: number;
  DEFAULT_REQUEST_TIMEOUT_MS: number;
  USER_AGENT: string;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';

  IMAGE_DOWNLOAD_TIMEOUT_MS: number;
  VK_UPLOAD_TIMEOUT_MS: number;

  OPENROUTER_API_KEY: string | undefined;
  OPENROUTER_MODEL: string;
  OPENROUTER_MODEL_NAME: string;
  OPENROUTER_PROMPT_FILE: string;
  OPENROUTER_TIMEOUT_MS: number;
  OPENROUTER_MAX_TOKENS: number;

  DATABASE_PATH: string;
  SOURCES_FILE: string;
}

class EnvErrors {
  private readonly issues: string[] = [];

  add(name: string, message: string): void {
    this.issues.push(`  - ${name}: ${message}`);
  }

  throwIfAny(): void {
    if (this.issues.length > 0) {
      throw new Error(
        `Invalid environment configuration:\n${this.issues.join('\n')}`
      );
    }
  }
}

function requiredString(
  name: string,
  errors: EnvErrors
): string {
  const value = process.env[name];

  if (!value) {
    errors.add(name, 'is required');
    return '';
  }

  return value;
}

function stringWithDefault(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function numberWithDefault(
  name: string,
  fallback: number,
  errors: EnvErrors
): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    errors.add(name, `must be a finite number, got "${value}"`);
    return fallback;
  }

  return parsed;
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function logLevel(errors: EnvErrors): Env['LOG_LEVEL'] {
  const value = process.env.LOG_LEVEL ?? 'info';

  if (!(LOG_LEVELS as readonly string[]).includes(value)) {
    errors.add('LOG_LEVEL', `must be one of ${LOG_LEVELS.join(', ')}, got "${value}"`);
    return 'info';
  }

  return value as Env['LOG_LEVEL'];
}

export function loadEnv(): Env {
  const errors = new EnvErrors();
  const env: Env = {
    VK_TOKEN: requiredString('VK_TOKEN', errors),

    TARGET_CHAT: numberWithDefault('TARGET_CHAT', 2_000_000_001, errors),
    ADMIN_CHAT: numberWithDefault('ADMIN_CHAT', 2_000_000_003, errors),
    OWNER_ID: numberWithDefault('OWNER_ID', 281_457_599, errors),
    DEFAULT_POLL_INTERVAL_MS: numberWithDefault(
      'DEFAULT_POLL_INTERVAL_MS',
      60_000,
      errors
    ),
    DEFAULT_REQUEST_TIMEOUT_MS: numberWithDefault(
      'DEFAULT_REQUEST_TIMEOUT_MS',
      30_000,
      errors
    ),
    USER_AGENT: stringWithDefault('USER_AGENT', 'VK-Feed-Bot/2.0'),

    LOG_LEVEL: logLevel(errors),
    IMAGE_DOWNLOAD_TIMEOUT_MS: numberWithDefault(
      'IMAGE_DOWNLOAD_TIMEOUT_MS',
      60_000,
      errors
    ),
    VK_UPLOAD_TIMEOUT_MS: numberWithDefault(
      'VK_UPLOAD_TIMEOUT_MS',
      90_000,
      errors
    ),
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || undefined,
    OPENROUTER_MODEL: stringWithDefault('OPENROUTER_MODEL', 'z-ai/glm-5.2:free'),
    OPENROUTER_MODEL_NAME: stringWithDefault('OPENROUTER_MODEL_NAME', 'GLM 5.2'),
    OPENROUTER_PROMPT_FILE: stringWithDefault(
      'OPENROUTER_PROMPT_FILE',
      'templates/ai_comment.txt'
    ),
    OPENROUTER_TIMEOUT_MS: numberWithDefault('OPENROUTER_TIMEOUT_MS', 30_000, errors),
    OPENROUTER_MAX_TOKENS: numberWithDefault('OPENROUTER_MAX_TOKENS', 700, errors),
    DATABASE_PATH: stringWithDefault('DATABASE_PATH', 'data/bot.db'),
    SOURCES_FILE: stringWithDefault('SOURCES_FILE', 'config/sources.yml')
  };

  errors.throwIfAny();

  return env;
}
