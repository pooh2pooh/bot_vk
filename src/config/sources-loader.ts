import { readFile } from 'node:fs/promises';

import YAML from 'yaml';

import type { SourceConfig } from './source-config.js';

interface RawSource {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  enabled?: unknown;
  url?: unknown;
  requireImages?: unknown;
  imageExtractor?: unknown;
  enrich?: unknown;
  template?: unknown;
  pollIntervalMs?: unknown;
  requestTimeoutMs?: unknown;
  promptPath?: unknown;
}

const ID_PATTERN = /^[a-z0-9_-]+$/;

function fail(path: string, issues: string[], message: string): void {
  issues.push(`  - ${path}: ${message}`);
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseOne(
  raw: RawSource,
  index: number,
  issues: string[]
): SourceConfig | null {
  const path = `sources[${index}]`;

  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) {
    fail(path, issues, 'id must be a lowercase a-z0-9_- string');
    return null;
  }

  if (typeof raw.url !== 'string' || !isValidUrl(raw.url)) {
    fail(`${path}.url`, issues, 'must be a valid http(s) URL');
    return null;
  }

  if (typeof raw.template !== 'string' || !raw.template) {
    fail(`${path}.template`, issues, 'is required (path to a .yml template file)');
    return null;
  }

  if (raw.pollIntervalMs !== undefined && typeof raw.pollIntervalMs !== 'number') {
    fail(`${path}.pollIntervalMs`, issues, 'must be a number');
    return null;
  }

  if (
    raw.requestTimeoutMs !== undefined &&
    typeof raw.requestTimeoutMs !== 'number'
  ) {
    fail(`${path}.requestTimeoutMs`, issues, 'must be a number');
    return null;
  }

  if (raw.promptPath !== undefined && typeof raw.promptPath !== 'string') {
    fail(`${path}.promptPath`, issues, 'must be a string');
    return null;
  }

  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
    type: typeof raw.type === 'string' && raw.type ? raw.type : 'rss',
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    url: raw.url,
    requireImages:
      typeof raw.requireImages === 'boolean' ? raw.requireImages : false,
    imageExtractor:
      typeof raw.imageExtractor === 'string' && raw.imageExtractor
        ? raw.imageExtractor
        : 'none',
    enrich: typeof raw.enrich === 'string' && raw.enrich ? raw.enrich : 'none',
    template: raw.template,
    pollIntervalMs: raw.pollIntervalMs as number | undefined,
    requestTimeoutMs: raw.requestTimeoutMs as number | undefined,
    promptPath: raw.promptPath as string | undefined
  };
}

export async function loadSources(path: string): Promise<SourceConfig[]> {
  const raw = await readFile(path, 'utf8');
  const parsed = YAML.parse(raw) as unknown;

  const issues: string[] = [];

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { sources?: unknown }).sources)
  ) {
    throw new Error(`Invalid ${path}: expected a top-level "sources" array`);
  }

  const rawSources = (parsed as { sources: RawSource[] }).sources;

  if (rawSources.length === 0) {
    throw new Error(`Invalid ${path}: "sources" must contain at least one entry`);
  }

  const sources = rawSources
    .map((entry, index) => parseOne(entry, index, issues))
    .filter((entry): entry is SourceConfig => entry !== null);

  const seenIds = new Set<string>();

  for (const source of sources) {
    if (seenIds.has(source.id)) {
      fail('sources', issues, `duplicate source id "${source.id}"`);
    }

    seenIds.add(source.id);
  }

  if (issues.length > 0) {
    throw new Error(`Invalid ${path}:\n${issues.join('\n')}`);
  }

  return sources;
}
