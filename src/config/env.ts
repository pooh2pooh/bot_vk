import 'dotenv/config';

/**
 * `.env` хранит ТОЛЬКО секреты и глобальную политику проекта.
 *
 * Настройки источников (адрес фида, интервалы, шаблоны, промпты) живут в
 * `config/sources.yml` — это несекретная информация, её удобнее ревьюить
 * diff-ом. Одной и той же настройки в двух местах быть не должно: иначе
 * непонятно, какое из двух значений победит, и применение значения случается тихо.
 *
 * Всё обязательное проверяется на старте. Значения по умолчанию не подставляются
 * там, где.default мог бы оказаться чужим: id чатов и id владельца у каждого
 * развёртывания свои, и «default» означал бы отправку сообщений не туда.
 */
export interface Env {
  /** Токен сообщества VK с правами на сообщения. */
  VK_TOKEN: string;
  /** Куда постить: id чата, вида {@link https://dev.vk.com/ru/method/messages.send | messages.send}. */
  TARGET_CHAT: number;
  /** Куда слать отчёты об ошибках: id чата или id пользователя. */
  ADMIN_CHAT: number;
  /** id пользователя, которому доступны административные команды. */
  OWNER_ID: number;

  /** User-Agent для всех HTTP-запросов. Часть сайтов режет запросы без него. */
  USER_AGENT: string;

  /** Потолок одновременных загрузок страниц постов одного источника. */
  MAX_PARALLEL_PAGE_REQUESTS: number;
  /** Сколько разобранных страниц постов держит стратегия сайта в памяти. */
  PAGE_CACHE_SIZE: number;

  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';

  /** Таймаут загрузки картинки, мс. */
  IMAGE_DOWNLOAD_TIMEOUT_MS: number;
  /** Таймаут загрузки картинки в VK, мс. */
  VK_UPLOAD_TIMEOUT_MS: number;

  /** null, если ключ не задан: тогда `enrich: openrouter` недоступен. */
  OPENROUTER_API_KEY: string | undefined;
  OPENROUTER_MODEL: string;
  /** Имя модели для подписи в сообщении, а не её технический идентификатор. */
  OPENROUTER_MODEL_NAME: string;
  OPENROUTER_TIMEOUT_MS: number;
  OPENROUTER_MAX_TOKENS: number;
  OPENROUTER_MAX_ATTEMPTS: number;
  OPENROUTER_RETRY_DELAY_MS: number;

  DATABASE_PATH: string;
  SOURCES_FILE: string;
}

/**
 * Собирает список проблем с окружением вместо падения на первой.
 *
 * Бот запускается под pm2 и перезапускается при ошибке: падение на первом же
 * неверном поле означало бы серию рестартов, каждый — с одним и тем же
 * сообщением об одном и том же поле. Пользователю нужен весь список сразу.
 */
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

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function requiredString(name: string, errors: EnvErrors): string {
  const value = process.env[name]?.trim();

  if (!value) {
    errors.add(name, 'is required');
    return '';
  }

  return value;
}

function requiredPositiveInt(name: string, errors: EnvErrors): number {
  const raw = requiredString(name, errors);

  if (!raw) {
    return 0;
  }

  const parsed = Number(raw);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    errors.add(name, `must be a positive integer, got "${raw}"`);
    return 0;
  }

  return parsed;
}

function optionalString(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function stringWithDefault(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function positiveIntWithDefault(
  name: string,
  fallback: number,
  errors: EnvErrors
): number {
  const raw = optionalString(name);

  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    errors.add(name, `must be a positive integer, got "${raw}"`);
    return fallback;
  }

  return parsed;
}

function logLevel(errors: EnvErrors): Env['LOG_LEVEL'] {
  const value = process.env.LOG_LEVEL?.trim() ?? 'info';

  if (!(LOG_LEVELS as readonly string[]).includes(value)) {
    errors.add(
      'LOG_LEVEL',
      `must be one of ${LOG_LEVELS.join(', ')}, got "${value}"`
    );

    return 'info';
  }

  return value as Env['LOG_LEVEL'];
}

export function loadEnv(): Env {
  const errors = new EnvErrors();

  const env: Env = {
    VK_TOKEN: requiredString('VK_TOKEN', errors),

    TARGET_CHAT: requiredPositiveInt('TARGET_CHAT', errors),
    ADMIN_CHAT: requiredPositiveInt('ADMIN_CHAT', errors),
    OWNER_ID: requiredPositiveInt('OWNER_ID', errors),

    USER_AGENT: stringWithDefault('USER_AGENT', 'VK-Feed-Bot/2.0'),
    MAX_PARALLEL_PAGE_REQUESTS: positiveIntWithDefault(
      'MAX_PARALLEL_PAGE_REQUESTS',
      5,
      errors
    ),
    PAGE_CACHE_SIZE: positiveIntWithDefault('PAGE_CACHE_SIZE', 500, errors),

    LOG_LEVEL: logLevel(errors),
    IMAGE_DOWNLOAD_TIMEOUT_MS: positiveIntWithDefault(
      'IMAGE_DOWNLOAD_TIMEOUT_MS',
      60_000,
      errors
    ),
    VK_UPLOAD_TIMEOUT_MS: positiveIntWithDefault(
      'VK_UPLOAD_TIMEOUT_MS',
      90_000,
      errors
    ),

    OPENROUTER_API_KEY: optionalString('OPENROUTER_API_KEY'),
    OPENROUTER_MODEL: stringWithDefault(
      'OPENROUTER_MODEL',
      'z-ai/glm-5.2:free'
    ),
    OPENROUTER_MODEL_NAME: stringWithDefault(
      'OPENROUTER_MODEL_NAME',
      'GLM 5.2'
    ),
    OPENROUTER_TIMEOUT_MS: positiveIntWithDefault(
      'OPENROUTER_TIMEOUT_MS',
      30_000,
      errors
    ),
    OPENROUTER_MAX_TOKENS: positiveIntWithDefault(
      'OPENROUTER_MAX_TOKENS',
      700,
      errors
    ),
    OPENROUTER_MAX_ATTEMPTS: positiveIntWithDefault(
      'OPENROUTER_MAX_ATTEMPTS',
      3,
      errors
    ),
    OPENROUTER_RETRY_DELAY_MS: positiveIntWithDefault(
      'OPENROUTER_RETRY_DELAY_MS',
      2_000,
      errors
    ),

    DATABASE_PATH: stringWithDefault('DATABASE_PATH', 'data/bot.db'),
    SOURCES_FILE: stringWithDefault('SOURCES_FILE', 'config/sources.yml')
  };

  errors.throwIfAny();

  return env;
}