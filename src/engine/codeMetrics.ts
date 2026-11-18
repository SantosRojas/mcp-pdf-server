/**
 * Shared metrics for the CodeBlock renderer: font fitting, soft wrapping and gutter sizing.
 *
 * These helpers are pure so they can be unit tested without rendering a PDF. They exist
 * because everything a reader copies out of a PDF comes from the text layer: the fewer
 * visual line breaks a block needs, the closer the pasted result is to the original source.
 */

export const CODE_BASE_FONT_SIZE = 7.4;
export const CODE_MIN_FONT_SIZE = 5.8;
export const CODE_LINE_HEIGHT = 1.35;

/** JetBrains Mono and Courier both advance 0.6em per glyph. */
const MONO_ADVANCE = 0.6;
/** Space reserved between the line numbers and the code column. */
export const GUTTER_RIGHT_PADDING = 7;
const GUTTER_SPACING = 9;
const GUTTER_MIN_WIDTH = 24;
const TAB_WIDTH = 4;

export type CodeWrapMode = 'fit' | 'soft';

export interface CodeMetrics {
  /** Font size actually used, after auto-fitting long lines. */
  fontSize: number;
  /** Characters that fit in one visual row at `fontSize`. */
  columns: number;
}

/** Expands tabs so the column count used for wrapping matches what the reader sees. */
export function expandTabs(line: string, tabWidth = TAB_WIDTH): string {
  if (!line.includes('\t')) return line;
  let result = '';
  for (const char of line) {
    result += char === '\t' ? ' '.repeat(tabWidth - (result.length % tabWidth)) : char;
  }
  return result;
}

/** Normalizes line endings and expands tabs, preserving the original line order. */
export function normalizeCodeLines(code: string): string[] {
  return code.replace(/\r\n?/g, '\n').split('\n').map((line) => expandTabs(line));
}

/**
 * Width of the line-number gutter. Derived from the base font size (not the fitted one)
 * so the gutter never changes width while the code font shrinks.
 */
export function codeGutterWidth(maxLineNumber: number): number {
  const digits = String(Math.max(1, Math.trunc(maxLineNumber))).length;
  return Math.max(GUTTER_MIN_WIDTH, Math.round(GUTTER_SPACING + digits * CODE_BASE_FONT_SIZE * MONO_ADVANCE));
}

/**
 * Picks the font size for a block. In `fit` mode the font shrinks (down to a floor) before
 * any line is wrapped; `soft` keeps the base size and wraps at the available width.
 */
export function computeCodeMetrics(lines: string[], availableWidth: number, mode: CodeWrapMode = 'fit'): CodeMetrics {
  const width = Math.max(60, availableWidth);
  const longest = lines.reduce((max, line) => Math.max(max, [...line].length), 1);
  let fontSize = CODE_BASE_FONT_SIZE;
  if (mode === 'fit') {
    const needed = longest * CODE_BASE_FONT_SIZE * MONO_ADVANCE;
    if (needed > width) {
      const fitted = Math.floor((width / (longest * MONO_ADVANCE)) * 100) / 100;
      fontSize = Math.max(CODE_MIN_FONT_SIZE, fitted);
    }
  }
  const columns = Math.max(8, Math.floor(width / (fontSize * MONO_ADVANCE)));
  return { fontSize, columns };
}

/**
 * Splits a line that does not fit. Continuation rows keep the literal source characters:
 * the renderer never injects indentation, otherwise every copy/paste carries phantom
 * leading spaces that the reader has to clean by hand.
 */
export function wrapCodeLine(line: string, columns: number): string[] {
  if ([...line].length <= columns) return [line];
  const segments: string[] = [];
  let remaining = line;
  while ([...remaining].length > columns) {
    const characters = [...remaining];
    const window = characters.slice(0, columns).join('');
    const lastSpace = window.lastIndexOf(' ');
    const breakAt = lastSpace >= Math.floor(columns * 0.45) ? lastSpace : columns;
    segments.push(characters.slice(0, breakAt).join('').replace(/\s+$/, ''));
    remaining = characters.slice(breakAt).join('').replace(/^\s+/, '');
    if (remaining.length === 0) break;
  }
  if (remaining.length > 0) segments.push(remaining);
  return segments.length > 0 ? segments : [''];
}
