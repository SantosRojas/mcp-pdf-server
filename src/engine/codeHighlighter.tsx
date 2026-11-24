import React from 'react';
import { Text as PdfText } from '@react-pdf/renderer';
import { common, createLowlight } from 'lowlight';

const highlighter = createLowlight(common);

const LANGUAGE_ALIASES: Record<string, string> = {
  html: 'xml',
  dockerfile: 'bash'
};

const NO_LIGATURES = { calt: false, liga: false, clig: false, dlig: false, rlig: false };

const lightTokenColors: Record<string, string> = {
  keyword: '#7C3AED', selector: '#7C3AED', 'built_in': '#0F766E',
  string: '#15803D', 'meta-string': '#15803D', number: '#B45309', literal: '#B45309',
  comment: '#64748B', doctag: '#0F766E', title: '#2563EB', 'title.function': '#2563EB',
  'attr': '#B45309', 'attribute': '#B45309', type: '#0F766E', variable: '#C2410C',
  symbol: '#C026D3', regexp: '#BE123C', meta: '#64748B', operator: '#475569',
  punctuation: '#64748B', params: '#334155'
};

const darkTokenColors: Record<string, string> = {
  keyword: '#C4B5FD', selector: '#C4B5FD', 'built_in': '#5EEAD4',
  string: '#86EFAC', 'meta-string': '#86EFAC', number: '#FCD34D', literal: '#FCD34D',
  comment: '#94A3B8', doctag: '#5EEAD4', title: '#93C5FD', 'title.function': '#93C5FD',
  'attr': '#FCD34D', 'attribute': '#FCD34D', type: '#5EEAD4', variable: '#FDBA74',
  symbol: '#F0ABFC', regexp: '#FDA4AF', meta: '#CBD5E1', operator: '#CBD5E1',
  punctuation: '#94A3B8', params: '#E2E8F0'
};

export interface HighlightSpan {
  text: string;
  color: string;
  bold?: boolean;
  italic?: boolean;
}

function resolveLanguage(language: string): string | undefined {
  if (!language || language === 'text') return undefined;
  if (highlighter.registered(language)) return language;
  const alias = LANGUAGE_ALIASES[language];
  if (alias && highlighter.registered(alias)) return alias;
  return undefined;
}

function flatten(
  node: any,
  inheritedColor: string,
  inheritedBold: boolean,
  inheritedItalic: boolean,
  palette: Record<string, string>,
  result: HighlightSpan[]
): void {
  if (node.type === 'text') {
    if (node.value) {
      result.push({
        text: node.value,
        color: inheritedColor,
        ...(inheritedBold ? { bold: true } : {}),
        ...(inheritedItalic ? { italic: true } : {})
      });
    }
    return;
  }
  const classes: string[] = node.properties?.className ?? [];
  const className = classes.map((item: string) => item.replace(/^hljs-/, '')).find((item: string) => palette[item]);
  const color = className ? palette[className]! : inheritedColor;
  const bold = inheritedBold || classes.some((item: string) => ['hljs-keyword', 'hljs-title', 'hljs-built_in'].includes(item));
  const italic = inheritedItalic || classes.some((item: string) => item === 'hljs-comment');
  for (const child of node.children ?? []) flatten(child, color, bold, italic, palette, result);
}

/**
 * Tokenizes an entire code block once so multi-line comments and strings keep their syntax
 * state across line breaks, then splits the flat token stream into source lines.
 */
export function tokenizeCodeLines(code: string, language: string, baseColor: string, dark = false): HighlightSpan[][] {
  const normalized = code.replace(/\r\n?/g, '\n');
  const resolved = resolveLanguage(language);
  if (!resolved) {
    return normalized.split('\n').map((line) => (line ? [{ text: line, color: baseColor }] : []));
  }
  try {
    const tree = highlighter.highlight(resolved, normalized);
    const palette = dark ? darkTokenColors : lightTokenColors;
    const flat: HighlightSpan[] = [];
    for (const child of tree.children) flatten(child, baseColor, false, false, palette, flat);
    const lines: HighlightSpan[][] = [[]];
    for (const span of flat) {
      const parts = span.text.split('\n');
      parts.forEach((part, idx) => {
        if (idx > 0) lines.push([]);
        if (part.length > 0) {
          lines[lines.length - 1]!.push({
            text: part,
            color: span.color,
            ...(span.bold ? { bold: true } : {}),
            ...(span.italic ? { italic: true } : {})
          });
        }
      });
    }
    return lines;
  } catch {
    return normalized.split('\n').map((line) => (line ? [{ text: line, color: baseColor }] : []));
  }
}

export function sliceHighlightSpans(spans: readonly HighlightSpan[], start: number, length: number): HighlightSpan[] {
  if (length <= 0 || spans.length === 0) return [];
  const end = start + length;
  const out: HighlightSpan[] = [];
  let offset = 0;
  for (const span of spans) {
    const spanEnd = offset + span.text.length;
    if (spanEnd > start && offset < end) {
      const sliceStart = Math.max(0, start - offset);
      const sliceEnd = Math.min(span.text.length, end - offset);
      if (sliceEnd > sliceStart) {
        out.push({
          text: span.text.slice(sliceStart, sliceEnd),
          color: span.color,
          ...(span.bold ? { bold: true } : {}),
          ...(span.italic ? { italic: true } : {})
        });
      }
    }
    offset = spanEnd;
    if (offset >= end) break;
  }
  return out;
}

export function renderHighlightSpans(spans: readonly HighlightSpan[], fallbackText: string): React.ReactNode {
  if (spans.length === 0) return fallbackText;
  return spans.map((token, index) => (
    <PdfText
      key={index}
      style={{
        color: token.color,
        fontFeatureSettings: NO_LIGATURES,
        ...(token.bold ? { fontWeight: 700 } : {}),
        ...(token.italic ? { fontStyle: 'italic' } : {})
      }}
    >{token.text}</PdfText>
  ));
}

export function renderHighlightedLine(line: string, language: string, baseColor: string, dark = false): React.ReactNode {
  const [first = []] = tokenizeCodeLines(line, language, baseColor, dark);
  return renderHighlightSpans(first, line);
}
