/**
 * analyzer.ts — «мозг» плагина. Здесь нет ни одного обращения к VS Code:
 * на вход приходит просто текст файла, на выходе — список функций с метриками.
 * Благодаря этому анализатор легко тестировать отдельно от редактора.
 *
 * Идея в три шага:
 *   1. Очистить текст от комментариев и строк (чтобы `if` внутри строки не считался).
 *   2. Найти функции: пройтись по всем `{` и для каждой понять, что это за блок.
 *   3. Для каждой функции посчитать метрики по её телу.
 */

/** Метрики одной функции. */
export interface FunctionMetrics {
  /** Имя функции. */
  name: string;
  /** Строка (с нуля), на которой стоит имя функции. Над ней рисуется CodeLens. */
  line: number;
  /** Строка (с нуля), на которой функция закрывается. */
  endLine: number;
  /** Цикломатическая сложность: 1 + число точек ветвления. */
  complexity: number;
  /** Максимальная вложенность управляющих блоков (if/for/while/...) внутри функции. */
  maxNesting: number;
}

/** Слова, после `(...)` которых идёт управляющий блок, а не тело функции. */
const CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'foreach', 'synchronized', 'using', 'lock',
]);

/** Слова, после которых `{` без скобок тоже открывает управляющий блок. */
const BARE_CONTROL_RE = /(?<![\w$.])(?:else|do|try|finally)\s*$/;

/** Что именно считаем точками ветвления (из ТЗ): if, for, while, case, catch, &&, ||. */
const BRANCH_RE = /(?<![\w$.#])(?:if|for|while|case|catch)(?![\w$])|&&|\|\|/g;

/**
 * Шаг 1. Заменяет содержимое комментариев и строковых литералов пробелами.
 * Длина текста и переводы строк сохраняются, поэтому позиции символов
 * в очищенном тексте совпадают с позициями в исходном.
 */
export function stripCommentsAndStrings(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;

  /** Пробел вместо символа, но переводы строк оставляем — иначе съедут номера строк. */
  const blank = (ch: string): string => (ch === '\n' || ch === '\r' ? ch : ' ');

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      // Однострочный комментарий: до конца строки.
      while (i < n && src[i] !== '\n') {
        out.push(' ');
        i++;
      }
    } else if (ch === '/' && next === '*') {
      // Многострочный комментарий: до `*/`.
      out.push(' ', ' ');
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out.push(blank(src[i]));
        i++;
      }
      if (i < n) {
        out.push(' ', ' ');
        i += 2;
      }
    } else if (ch === '"' || ch === "'" || ch === '`') {
      // Строковый литерал: до закрывающей такой же кавычки, учитывая экранирование `\"`.
      const quote = ch;
      out.push(quote);
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          out.push(' ', blank(src[i + 1]));
          i += 2;
        } else if (src[i] === '\n' && quote !== '`') {
          break; // незакрытая строка — не даём ей съесть весь файл
        } else {
          out.push(blank(src[i]));
          i++;
        }
      }
      if (i < n && src[i] === quote) {
        out.push(quote);
        i++;
      }
    } else {
      out.push(ch);
      i++;
    }
  }
  return out.join('');
}

/** Описание того, что собой представляет открывающая скобка `{`. */
type BraceInfo =
  | { kind: 'function'; name: string; nameOffset: number }
  | { kind: 'control' }
  | { kind: 'other' };

/** Ищет открывающую скобку (open), парную к закрывающей (close) на позиции closeIdx, двигаясь назад. -1, если не нашли. */
function findMatchingOpen(text: string, closeIdx: number, open = '(', close = ')'): number {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    if (text[i] === close) depth++;
    else if (text[i] === open) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Особый случай C++: конструктор со списком инициализации `Foo() : a(1), b(2) {`.
 * Перед `{` стоит `b(2)`, но функция на самом деле `Foo`. Идём назад по элементам списка
 * до двоеточия и находим имя конструктора. Принимает текст до первого элемента списка.
 */
function resolveInitList(s: string): { name: string; index: number } | null {
  let cur = s;
  for (let guard = 0; guard < 100; guard++) {
    if (cur.endsWith(',')) {
      // Пропускаем один предыдущий элемент вида `name(...)` или `name{...}`.
      cur = cur.slice(0, -1).replace(/\s+$/, '');
      const last = cur[cur.length - 1];
      const open = last === ')' ? findMatchingOpen(cur, cur.length - 1) : last === '}' ? findMatchingOpen(cur, cur.length - 1, '{', '}') : -1;
      if (open < 0) return null;
      cur = cur.slice(0, open).replace(/[\w:<>$~]+\s*$/, '').replace(/\s+$/, '');
    } else if (/(?<!:):$/.test(cur)) {
      // Дошли до `:` — перед ним список параметров конструктора.
      cur = cur.slice(0, -1).replace(/\s+$/, '').replace(/\s+(?:const|noexcept)$/, '');
      if (!cur.endsWith(')')) return null;
      const open = findMatchingOpen(cur, cur.length - 1);
      if (open < 0) return null;
      const m = /([A-Za-z_~$][\w$]*)\s*$/.exec(cur.slice(0, open));
      return m ? { name: m[1], index: m.index } : null;
    } else {
      return null;
    }
  }
  return null;
}

/**
 * Шаг 2 (ключевой). По позиции `{` определяет, что это за блок:
 * тело функции, управляющий блок (if/for/...) или что-то другое (класс, namespace, объект).
 *
 * Смотрим на текст ПЕРЕД скобкой. Тело функции выглядит как `имя(...)` + `{`,
 * управляющий блок — как `if(...)`/`for(...)` + `{`, `else {`, `try {` и т. д.
 */
function classifyBrace(text: string, bracePos: number): BraceInfo {
  // Берём ограниченный кусок перед `{`, чтобы не гонять regexp по всему файлу.
  const windowStart = Math.max(0, bracePos - 400);
  let prefix = text.slice(windowStart, bracePos).replace(/\s+$/, '');

  if (BARE_CONTROL_RE.test(prefix)) return { kind: 'control' };

  // Стрелочная функция: `const foo = (a, b) => {` или `foo = async x => {`.
  if (prefix.endsWith('=>')) {
    const m = /([A-Za-z_$][\w$]*)\s*(?::[^=;{}]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=;{}]+?)?\s*=>$/.exec(prefix);
    if (m) {
      const nameOffset = windowStart + m.index;
      return { kind: 'function', name: m[1], nameOffset };
    }
    return { kind: 'other' }; // анонимный колбэк — считаем частью внешней функции
  }

  // Отбрасываем «хвосты» после списка параметров: const, noexcept, throws X, `: Тип`, `-> Тип`.
  let prev: string;
  do {
    prev = prefix;
    prefix = prefix
      .replace(/\s+(?:const|noexcept|override|final|volatile|mutable)$/, '')
      .replace(/\s+throws\s+[\w\s,.<>]+$/, '')
      .replace(/(\))\s*(?::|->)\s*[\w\s<>,[\].*&:|?]+$/, '$1')
      .replace(/\s+$/, '');
  } while (prefix !== prev);

  if (!prefix.endsWith(')')) return { kind: 'other' };

  const openIdx = findMatchingOpen(prefix, prefix.length - 1);
  if (openIdx < 0) return { kind: 'other' };

  // Идентификатор прямо перед `(`.
  const before = prefix.slice(0, openIdx);
  const m = /([A-Za-z_~$][\w$]*)\s*$/.exec(before);
  if (!m) return { kind: 'other' }; // например, C++-лямбда `[&](int x) {`

  // Если перед идентификатором стоит `:` или `,` — это элемент списка инициализации C++.
  const beforeName = before.slice(0, m.index).replace(/\s+$/, '');
  if (/(?<!:):$/.test(beforeName) || beforeName.endsWith(',')) {
    const ctor = resolveInitList(beforeName);
    return ctor ? { kind: 'function', name: ctor.name, nameOffset: windowStart + ctor.index } : { kind: 'other' };
  }

  const word = m[1];
  if (CONTROL_KEYWORDS.has(word)) return { kind: 'control' };
  if (word === 'function') return { kind: 'other' }; // анонимная function() {...}

  return { kind: 'function', name: word, nameOffset: windowStart + m.index };
}

/** Смещения начал строк — чтобы быстро переводить позицию в символах в номер строки. */
function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** Бинарный поиск: в какой строке лежит символ с позицией offset. */
function offsetToLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Найденная функция до подсчёта метрик: где начинается и заканчивается её тело. */
interface RawFunction {
  name: string;
  nameOffset: number;
  bodyStart: number; // позиция `{`
  bodyEnd: number; // позиция парной `}`
}

/**
 * Шаг 3. Метрики по телу функции [bodyStart+1, bodyEnd).
 * Сложность — подсчёт ключевых слов регуляркой.
 * Вложенность — проход по скобкам со стеком: `{` управляющего блока увеличивает глубину.
 */
function computeMetrics(text: string, fn: RawFunction): { complexity: number; maxNesting: number } {
  const body = text.slice(fn.bodyStart + 1, fn.bodyEnd);

  const matches = body.match(BRANCH_RE);
  const complexity = 1 + (matches ? matches.length : 0);

  // Стек: для каждой открытой `{` запоминаем, управляющий ли это блок.
  const stack: boolean[] = [];
  let depth = 0;
  let maxNesting = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') {
      const isControl = classifyBrace(text, fn.bodyStart + 1 + i).kind === 'control';
      stack.push(isControl);
      if (isControl) {
        depth++;
        if (depth > maxNesting) maxNesting = depth;
      }
    } else if (ch === '}') {
      const wasControl = stack.pop();
      if (wasControl) depth--;
    }
  }
  return { complexity, maxNesting };
}

/**
 * Главная функция анализатора: текст файла -> список функций с метриками.
 */
export function analyze(source: string): FunctionMetrics[] {
  const text = stripCommentsAndStrings(source);
  const lineStarts = buildLineStarts(text);

  // Проход по всему файлу со стеком открытых `{`.
  // На стек кладём либо найденную функцию, либо null (для остальных блоков).
  const stack: (Omit<RawFunction, 'bodyEnd'> | null)[] = [];
  const found: RawFunction[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      const info = classifyBrace(text, i);
      if (info.kind === 'function') {
        stack.push({ name: info.name, nameOffset: info.nameOffset, bodyStart: i });
      } else {
        stack.push(null);
      }
    } else if (ch === '}') {
      const top = stack.pop();
      if (top) found.push({ ...top, bodyEnd: i });
    }
  }

  return found
    .map((fn) => {
      const { complexity, maxNesting } = computeMetrics(text, fn);
      return {
        name: fn.name,
        line: offsetToLine(lineStarts, fn.nameOffset),
        endLine: offsetToLine(lineStarts, fn.bodyEnd),
        complexity,
        maxNesting,
      };
    })
    .sort((a, b) => a.line - b.line);
}
