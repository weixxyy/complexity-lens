/**
 * extension.ts — точка входа плагина Complexity Lens.
 * Здесь анализатор из analyzer.ts подключается к VS Code:
 *   - CodeLens: строка с метриками над каждой функцией;
 *   - подсветка жёлтым функций, у которых сложность выше порога;
 *   - команда «Показать отчёт по файлу»;
 *   - пересчёт при сохранении файла и при смене настроек.
 */
import * as vscode from 'vscode';
import { analyze, FunctionMetrics } from './analyzer';

/** Языки, для которых плагин работает (синтаксис с фигурными скобками). */
const SUPPORTED_LANGUAGES = [
  'c', 'cpp', 'java', 'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'csharp', 'go',
];

/** Кэш результатов анализа: ключ — адрес документа. Пересчитывается только при сохранении. */
const cache = new Map<string, FunctionMetrics[]>();

/** Стиль жёлтой подсветки строки функции, у которой сложность выше порога. */
const warnDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(255, 213, 0, 0.18)',
  isWholeLine: true,
  overviewRulerColor: 'rgba(255, 213, 0, 0.8)',
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

/** Читает порог сложности из настроек (по умолчанию 10). */
function getThreshold(): number {
  return vscode.workspace.getConfiguration('complexityLens').get<number>('threshold', 10);
}

function isSupported(doc: vscode.TextDocument): boolean {
  return SUPPORTED_LANGUAGES.includes(doc.languageId);
}

/** Анализирует документ и кладёт результат в кэш. */
function refresh(doc: vscode.TextDocument): FunctionMetrics[] {
  const metrics = analyze(doc.getText());
  cache.set(doc.uri.toString(), metrics);
  return metrics;
}

/** Берёт результат из кэша, а если его ещё нет — считает. */
function getMetrics(doc: vscode.TextDocument): FunctionMetrics[] {
  return cache.get(doc.uri.toString()) ?? refresh(doc);
}

/** Раскрашивает жёлтым строки функций, у которых сложность выше порога. */
function updateDecorations(editor: vscode.TextEditor): void {
  if (!isSupported(editor.document)) {
    editor.setDecorations(warnDecoration, []);
    return;
  }
  const threshold = getThreshold();
  const ranges: vscode.DecorationOptions[] = getMetrics(editor.document)
    .filter((m) => m.complexity > threshold)
    .map((m) => ({
      range: new vscode.Range(m.line, 0, m.line, 0),
      hoverMessage: `Сложность ${m.complexity} выше порога ${threshold}. Подумай, не разбить ли функцию на части.`,
    }));
  editor.setDecorations(warnDecoration, ranges);
}

/** Провайдер CodeLens: рисует строку с метриками над каждой функцией. */
class ComplexityLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** VS Code подписывается на это событие и перезапрашивает линзы, когда мы его «выстрелим». */
  readonly onDidChangeCodeLenses = this.emitter.event;

  /** Сообщает VS Code, что линзы нужно перерисовать. */
  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const threshold = getThreshold();
    return getMetrics(doc).map((m) => {
      const warn = m.complexity > threshold ? ' ⚠' : '';
      const title = `Сложность: ${m.complexity}${warn} · Вложенность: ${m.maxNesting}`;
      return new vscode.CodeLens(new vscode.Range(m.line, 0, m.line, 0), {
        title,
        command: 'complexity-lens.showReport', // клик по линзе открывает отчёт
      });
    });
  }
}

/** Команда «Показать отчёт по файлу»: таблица функций по убыванию сложности. */
function showReport(output: vscode.OutputChannel): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isSupported(editor.document)) {
    vscode.window.showInformationMessage('Complexity Lens: откройте файл на C/C++, Java, JS/TS, C# или Go.');
    return;
  }

  const metrics = [...getMetrics(editor.document)].sort((a, b) => b.complexity - a.complexity);
  const threshold = getThreshold();

  output.clear();
  output.appendLine(`Отчёт Complexity Lens: ${vscode.workspace.asRelativePath(editor.document.uri)}`);
  output.appendLine(`Порог сложности: ${threshold}`);
  output.appendLine('');

  if (metrics.length === 0) {
    output.appendLine('Функции не найдены.');
  } else {
    const nameWidth = Math.max(7, ...metrics.map((m) => m.name.length));
    output.appendLine(`${'Функция'.padEnd(nameWidth)} | Строка | Сложность | Вложенность`);
    output.appendLine(`${'-'.repeat(nameWidth)}-+--------+-----------+------------`);
    for (const m of metrics) {
      const mark = m.complexity > threshold ? ' ⚠' : '';
      output.appendLine(
        `${m.name.padEnd(nameWidth)} | ${String(m.line + 1).padStart(6)} | ${String(m.complexity).padStart(9)} | ${String(m.maxNesting).padStart(11)}${mark}`
      );
    }
  }
  output.show(true);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Complexity Lens');
  const lensProvider = new ComplexityLensProvider();

  // Всё, что регистрируем, кладём в context.subscriptions — VS Code уберёт это при выключении плагина.
  context.subscriptions.push(
    output,
    warnDecoration,

    // CodeLens для всех поддерживаемых языков.
    vscode.languages.registerCodeLensProvider(
      SUPPORTED_LANGUAGES.map((language) => ({ language })),
      lensProvider
    ),

    // Команда отчёта (идентификатор должен совпасть с package.json).
    vscode.commands.registerCommand('complexity-lens.showReport', () => showReport(output)),

    // Пересчёт при СОХРАНЕНИИ файла (требование ТЗ).
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!isSupported(doc)) return;
      refresh(doc);
      lensProvider.refresh();
      vscode.window.visibleTextEditors
        .filter((e) => e.document === doc)
        .forEach(updateDecorations);
    }),

    // Когда пользователь переключился на другой файл — обновляем подсветку.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) updateDecorations(editor);
    }),

    // Если закрыли файл — чистим кэш, чтобы не копить память.
    vscode.workspace.onDidCloseTextDocument((doc) => cache.delete(doc.uri.toString())),

    // Изменили порог в настройках — перерисовываем всё.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('complexityLens')) {
        lensProvider.refresh();
        vscode.window.visibleTextEditors.forEach(updateDecorations);
      }
    })
  );

  // Первичная подсветка для уже открытого файла.
  if (vscode.window.activeTextEditor) updateDecorations(vscode.window.activeTextEditor);
}

export function deactivate(): void {
  cache.clear();
}
