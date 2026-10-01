import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileFilter } from '../core/filter.js';
import { isTextMode, TEXT_MODES } from '../core/text-mode.js';

/**
 * Фильтры конфигурации и режимы текста.
 *
 * Оба решают одну задачу — отобрать запись ДО разбора страницы, поэтому и
 * живут рядом. Проверяется здесь главное: заголовок проверяется целиком, а
 * повторный `.test()` на одной строке не чередует результаты.
 */

describe('compileFilter', () => {
  it('проверяет заголовок как отдельную строку', () => {
    const filter = compileFilter('^\\[Stable Update\\]', 'test');

    assert.equal(filter.matches('[Stable Update] Пакеты'), true);
    assert.equal(filter.matches('[Testing Update] Пакеты'), false);
  });

  it('^ привязан к началу заголовка, а не к началу подстроки', () => {
    // Наивная проверка по «заголовок + описание» нашла бы здесь совпадение
    // в описании и пропустила бы новость в ленту.
    const filter = compileFilter('^\\[Stable Update\\]', 'test');

    assert.equal(filter.matches('Обычная новость [Stable Update]'), false);
  });

  it('повторный .test() на одной строке даёт тот же результат', () => {
    // С флагом `g` состояние lastIndex живёт между вызовами, и чередование
    // true/false выглядело бы как «иногда работает, иногда нет».
    const filter = compileFilter('Update', 'test');

    assert.equal(filter.matches('[Stable Update]'), true);
    assert.equal(filter.matches('[Stable Update]'), true);
    assert.equal(filter.matches('[Stable Update]'), true);
  });

  it('ошибка компиляции называет поле и сам шаблон', () => {
    assert.throws(
      () => compileFilter('[Stable', 'manjaro.includeFilter'),
      /manjaro\.includeFilter.*\[Stable/s
    );
  });

  it('пустой шаблон в регулярке совпадает со всем — поэтому его не пускает загрузчик', () => {
    // Сама по себе регулярка с пустым шаблоном безобидна и совпадает со всем.
    // Именно поэтому пустая строка в `includeFilter`/`generateWhen` запрещена
    // схемой: иначе опечатка тихо отключила бы фильтр, а не сломала конфиг.
    assert.equal(compileFilter('', 'test').matches('что угодно'), true);
  });
});

describe('TextMode', () => {
  it('известные режимы', () => {
    assert.deepEqual([...TEXT_MODES], ['feed', 'feedFull', 'generated']);
  });

  it('isTextMode отличает режим от мусора', () => {
    for (const mode of TEXT_MODES) {
      assert.equal(isTextMode(mode), true, `${mode} — режим`);
    }

    assert.equal(isTextMode('truncated'), false, 'старое имя режима отвергнуто');
    assert.equal(isTextMode('full'), false, 'старое имя режима отвергнуто');
    assert.equal(isTextMode(''), false);
    assert.equal(isTextMode(undefined), false);
    assert.equal(isTextMode(null), false);
  });
});