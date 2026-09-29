import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Слой core/ — это контракты и общая механика. Он не должен знать ни про
 * конкретные сайты (sources/), ни про конфиг, ни про VK/SQLite.
 * Архитектурные инварианты дешевле держать тестом, чем ловить ревью.
 */

const SRC = resolve(import.meta.dirname, '..');
const CORE = join(SRC, 'core');

async function tsFilesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await tsFilesIn(full)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }

  return files;
}

/** Все относительные импорты вида `from './...'` в файле. */
async function relativeImports(file: string): Promise<string[]> {
  const source = await readFile(file, 'utf8');
  const specifiers: string[] = [];

  for (const match of source.matchAll(/from '(\.[^']*)'/g)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

/** Верхняя папка, в которую уходит относительный импорт. */
function topLevelSegment(from: string, specifier: string): string {
  const target = resolve(dirname(from), specifier);
  const path = relative(SRC, target);
  return path.split(/[\\/]/)[0] ?? '';
}

describe('architecture', () => {
  it('core/ не импортирует ничего за пределами core/', async () => {
    const offenders: string[] = [];

    for (const file of await tsFilesIn(CORE)) {
      for (const specifier of await relativeImports(file)) {
        if (!specifier.startsWith('./')) {
          offenders.push(`${relative(SRC, file)} -> ${specifier}`);
        }
      }
    }

    assert.deepEqual(offenders, []);
  });

  it('sources/ зависит только от core/', async () => {
    const sources = join(SRC, 'sources');
    const offenders: string[] = [];

    for (const file of await tsFilesIn(sources)) {
      for (const specifier of await relativeImports(file)) {
        if (specifier.startsWith('.')) {
          const top = topLevelSegment(file, specifier);

          if (top !== 'core') {
            offenders.push(
              `${relative(SRC, file)} -> ${specifier} (выходит в ${top}/)`
            );
          }
        }
      }
    }

    assert.deepEqual(offenders, []);
  });

  it('ни один файл не импортирует config/ из core/ или sources/', async () => {
    const offenders: string[] = [];

    for (const dir of [CORE, join(SRC, 'sources')]) {
      for (const file of await tsFilesIn(dir)) {
        for (const specifier of await relativeImports(file)) {
          if (topLevelSegment(file, specifier) === 'config') {
            offenders.push(`${relative(SRC, file)} -> ${specifier}`);
          }
        }
      }
    }

    assert.deepEqual(offenders, []);
  });
});
