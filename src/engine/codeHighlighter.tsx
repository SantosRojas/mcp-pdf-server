import React from 'react';
import { Text as PdfText } from '@react-pdf/renderer';
import { common, createLowlight } from 'lowlight';

const highlighter = createLowlight(common);

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

function flatten(
  node: any,
  inheritedColor: string,
  palette: Record<string, string>,
  result: Array<{ text: string; color: string; bold?: boolean; italic?: boolean }>
): void {
  if (node.type === 'text') {
    if (node.value) result.push({ text: node.value, color: inheritedColor });
    return;
  }
  const classes: string[] = node.properties?.className ?? [];
  const className = classes.map((item: string) => item.replace(/^hljs-/, '')).find((item: string) => palette[item]);
  const color = className ? palette[className]! : inheritedColor;
  const bold = classes.some((item: string) => ['hljs-keyword', 'hljs-title', 'hljs-built_in'].includes(item));
  const italic = classes.some((item: string) => item === 'hljs-comment');
  for (const child of node.children ?? []) flatten(child, color, palette, result);
  if ((bold || italic) && result.length) {
    result[result.length - 1] = {
      ...result[result.length - 1]!,
      ...(bold ? { bold: true } : {}),
      ...(italic ? { italic: true } : {})
    };
  }
}

export function renderHighlightedLine(line: string, language: string, baseColor: string, dark = false): React.ReactNode {
  if (language === 'text' || !highlighter.registered(language)) return line;
  try {
    const tree = highlighter.highlight(language, line);
    const palette = dark ? darkTokenColors : lightTokenColors;
    const tokens: Array<{ text: string; color: string; bold?: boolean; italic?: boolean }> = [];
    for (const child of tree.children) flatten(child, baseColor, palette, tokens);
    if (tokens.length === 0) return line;
    return tokens.map((token, index) => (
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
  } catch {
    return line;
  }
}
