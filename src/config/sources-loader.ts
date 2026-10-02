import { readFile } from 'node:fs/promises';

import YAML from 'yaml';

import { compileFilter } from '../core/filter.js';
import { isTextMode, TEXT_MODES } from '../core/text-mode.js';
import type { SourceConfig } from './source-config.js';

/**
 * Разбор `config/sources.yml` в `SourceConfig[]`.
 *
 * Принципы разбора, ради которых файл написан именно так:
 *
 *  - ПОЛНЫЙ список проблем, а не падение на первом. Бот перезапускается под
 *    pm2, и падение на первом поле означало бы серию рестартов с одним и тем же
 *    сообщением об одном и том же поле.
 *  - НИКАКИХ догадок. Поле либо обязательное и проверяется, либо необязательное.
 *    Режим текста раньше выводился из `enrich`, и опечатка в YAML молча
 *    превращала источник в другой источник. Теперь `textMode` обязателен, а
 *    рассогласование с `enrich` — ошибка, а не тихая подмена.
 *  - НИКАКОЙ ОБРАТНОЙ СОВМЕСТИМОСТИ. Старые и ошибочные имена полей не
 *    принимаются: неизвестное поле — ошибка с перечнем допустимых, а не
 *    молчаливое игнорирование.
 */

/** Как проверять одно поле: вид значения плюс конечное множество, если оно есть. */
interface FieldSpec {
  kind: 'id' | 'name' | 'url' | 'bool' | 'positiveInt' | 'textMode' | 'filter';
  /** Обязательное ли поле. */
  required?: boolean;
  /** Допустимые значения для строковых полей: ключи реестров и режимы. */
  allowed?: readonly string[];
}

/**
 * Таблица полей источника — единственный список правды о схеме `sources.yml`.
 * Добавление поля = одна строка здесь + одно место в `buildSource`.
 */
const FIELDS = {
  id: { kind: 'id', required: true },
  name: { kind: 'name', required: true },
  type: { kind: 'name', required: true, allowed: ['rss'] },
  site: { kind: 'name', required: true },
  enabled: { kind: 'bool', required: true },
  url: { kind: 'url', required: true },
  requireImages: { kind: 'bool', required: true },
  enrich: { kind: 'name', required: true, allowed: ['none', 'openrouter'] },
  textMode: { kind: 'textMode', required: true },
  textLimit: { kind: 'positiveInt', required: true },
  template: { kind: 'name', required: true },
  pollIntervalMs: { kind: 'positiveInt', required: true },
  requestTimeoutMs: { kind: 'positiveInt', required: true },
  promptPath: { kind: 'name' },
  includeFilter: { kind: 'filter' },
  generateWhen: { kind: 'filter' }
} as const satisfies Record<string, FieldSpec>;

type FieldName = keyof typeof FIELDS;
type RawSource = Record<string, unknown>;

const KNOWN_FIELDS = new Set<string>(Object.keys(FIELDS));
const ID_PATTERN = /^[a-z0-9_-]+$/;

/** Что именно не так со значением поля — для сообщения об ошибке. */
function describe(spec: FieldSpec, value: unknown): string {
  if (spec.kind === 'textMode') {
    return `must be one of ${TEXT_MODES.join(', ')}, got ${show(value)}`;
  }

  if (spec.allowed) {
    return `must be one of ${spec.allowed.join(', ')}, got ${show(value)}`;
  }

  switch (spec.kind) {
    case 'id':
      return `must be a lowercase a-z0-9_- string, got ${show(value)}`;

    case 'name':
      return `must be a non-empty string, got ${show(value)}`;

    case 'url':
      return `must be an http(s) URL, got ${show(value)}`;

    case 'bool':
      return `must be true or false, got ${show(value)}`;

    case 'positiveInt':
      return `must be a positive integer, got ${show(value)}`;

    case 'filter':
      return `must be a valid regular expression, got ${show(value)}`;
  }
}

function show(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : (JSON.stringify(value) ?? 'nothing');
}

/** То же самое, но для целого значения в сообщении об ошибке. */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'nothing';
  }

  return Array.isArray(value) ? 'a list' : show(value);
}

/** Проверяет значение против описания поля. */
function isValid(spec: FieldSpec, value: unknown): boolean {
  if (spec.kind === 'filter') {
    if (typeof value !== 'string' || !value) {
      return false;
    }

    try {
      // Фильтр компилируется здесь же: сломанный regexp тихо отсёк бы весь
      // фид, и пользователь увидел бы просто пустой источник.
      compileFilter(value, 'filter');

      return true;
    } catch {
      return false;
    }
  }

  if (spec.allowed) {
    return typeof value === 'string' && spec.allowed.includes(value);
  }

  switch (spec.kind) {
    case 'id':
      return typeof value === 'string' && ID_PATTERN.test(value);

    case 'name':
      return typeof value === 'string' && value.trim().length > 0;

    case 'url':
      return isHttpUrl(value);

    case 'bool':
      return typeof value === 'boolean';

    case 'positiveInt':
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

    case 'textMode':
      return isTextMode(value);
  }
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const url = new URL(value);

    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Согласованность полей, которые сами по себе валидны, но вместе бессмысленны.
 *
 * Ловят тот класс ошибок, ради которого убрана обратная совместимость: конфиг,
 * который загружается, но молча не делает того, что в нём написано.
 *
 * Два способа включить генерацию, и третий быть не должно:
 *
 *   1. `textMode: generated` — генерировать ВСЕ посты источника;
 *   2. `textMode: feed` (или `feedFull`) + `generateWhen: '...'` — генерировать
 *      только посты с подходящим заголовком, остальные отправлять как есть.
 */
function checkConsistency(
  source: SourceConfig,
  path: string,
  issues: string[]
): void {
  const usesAi = source.enrich !== 'none';

  if (usesAi && !source.promptPath) {
    issues.push(
      `  - ${path}.promptPath: is required when enrich is "${source.enrich}", ` +
        'because every source needs its own task for the model'
    );
  }

  if (!usesAi) {
    if (source.textMode === 'generated') {
      issues.push(
        `  - ${path}.textMode: "generated" requires enrich (currently "none"), ` +
          'the post would silently go out as plain feed text'
      );
    }

    if (source.generateWhen) {
      issues.push(
        `  - ${path}.generateWhen: has no effect with enrich "none" — ` +
          'there is nothing to generate with'
      );
    }

    return;
  }

  if (source.textMode === 'generated' && source.generateWhen) {
    /*
     * Сообщение обязано называть КАКОЕ поле убрать. Формулировка «убери одно из
     * двух» оставляла выбор админу, и для manjarо оба варианта выглядели
     * равнозначными, хотя правильный там ровно один.
     *
     * Если generateWhen повторяет includeFilter, выбор однозначен: посты, дошедшие
     * до конвейера, и так все подходят, поэтому нужен generated, а generateWhen —
     * тот же regexp вторым разом.
     */
    if (source.includeFilter === source.generateWhen) {
      issues.push(
        `  - ${path}.generateWhen: repeats includeFilter, so every post that ` +
          'reaches the pipeline already matches it — drop generateWhen and ' +
          'keep textMode: "generated"'
      );
    } else {
      issues.push(
        `  - ${path}: textMode "generated" generates every post, so ` +
          'generateWhen has no effect. Keep textMode: "generated" and drop ' +
          'generateWhen, or switch textMode to "feed" and keep generateWhen'
      );
    }
  }

  if (source.textMode !== 'generated' && !source.generateWhen) {
    issues.push(
      `  - ${path}: enrich is "${source.enrich}" but textMode is ` +
        `"${source.textMode}" and generateWhen is not set — ` +
        'the enricher would never be called'
    );
  }
}

function buildSource(
  raw: RawSource,
  index: number,
  issues: string[]
): SourceConfig | null {
  const path = `sources[${index}]`;
  const before = issues.length;

  for (const name of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(name)) {
      issues.push(
        `  - ${path}.${name}: unknown field. Allowed: ${[...KNOWN_FIELDS].join(', ')}`
      );
    }
  }

  const read = <K extends FieldName>(name: K): unknown => {
    const spec: FieldSpec = FIELDS[name];
    const value = raw[name];

    if (value === undefined || value === null) {
      if (spec.required) {
        issues.push(`  - ${path}.${name}: is required`);
      }

      return undefined;
    }

    if (!isValid(spec, value)) {
      issues.push(`  - ${path}.${name}: ${describe(spec, value)}`);

      return undefined;
    }

    return value;
  };

  const source: SourceConfig = {
    id: read('id') as string,
    name: read('name') as string,
    type: read('type') as string,
    site: read('site') as string,
    enabled: read('enabled') as boolean,
    url: read('url') as string,
    requireImages: read('requireImages') as boolean,
    enrich: read('enrich') as string,
    textMode: read('textMode') as SourceConfig['textMode'],
    textLimit: read('textLimit') as number,
    template: read('template') as string,
    pollIntervalMs: read('pollIntervalMs') as number,
    requestTimeoutMs: read('requestTimeoutMs') as number,
    promptPath: read('promptPath') as string | undefined,
    includeFilter: read('includeFilter') as string | undefined,
    generateWhen: read('generateWhen') as string | undefined
  };

  checkConsistency(source, path, issues);

  // При накопленных проблемах источник не собирается: лучше упасть сразу с
  // полным списком, чем отдать в пайплайн объект с дырами.
  return issues.length > before ? null : source;
}

/** Читает и проверяет `config/sources.yml`. */
export async function loadSources(path: string): Promise<SourceConfig[]> {
  const parsed = YAML.parse(await readFile(path, 'utf8')) as unknown;

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { sources?: unknown }).sources)
  ) {
    throw new Error(`Invalid ${path}: expected a top-level "sources" array`);
  }

  const rawSources = (parsed as { sources: unknown }).sources as unknown[];

  if (rawSources.length === 0) {
    throw new Error(`Invalid ${path}: "sources" must contain at least one entry`);
  }

  const issues: string[] = [];

  const sources = rawSources
    .map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push(
          `  - sources[${index}]: must be a mapping with source fields, got ${describeValue(raw)}`
        );

        return null;
      }

      return buildSource(raw as RawSource, index, issues);
    })
    .filter((source): source is SourceConfig => source !== null);

  // Дубликаты id ломают дедупликацию молча: два источника с одним id писали бы
  // в базу записи с одинаковым первичным ключом.
  const counted = new Map<string, number>();

  for (const source of sources) {
    const seen = (counted.get(source.id) ?? 0) + 1;

    counted.set(source.id, seen);

    // Сообщаем про каждый id ровно один раз, а не по разу на каждое повторение.
    if (seen === 2) {
      issues.push(`  - sources: duplicate source id "${source.id}"`);
    }
  }

  if (issues.length > 0) {
    throw new Error(`Invalid ${path}:\n${issues.join('\n')}`);
  }

  return sources;
}