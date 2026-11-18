import React from 'react';
import { Text as PdfText } from '@react-pdf/renderer';
import { common, createLowlight } from 'lowlight';

const highlighter = createLowlight(common);

const tokenColors: Record<string, string> = {
  keyword: '#7C3AED', selector: '#7C3AED', 'built_in': '#0F766E',
  string: '#15803D', 'meta-string': '#15803D', number: '#B45309', literal: '#B45309',
  comment: '#8492A6', doctag: '#0F766E', title: '#2563EB', 'title.function': '#2563EB',
  'attr': '#B45309', 'attribute': '#B45309', type: '#0F766E', variable: '#C2410C',
  symbol: '#C026D3', regexp: '#BE123C', meta: '#64748B', operator: '#475569',
  punctuation: '#64748B', params: '#475569'
};

function flatten(node: any, inheritedColor: string, result: Array<{ text: string; color: string; bold?: boolean; italic?: boolean }>): void {
  if (node.type === 'text') {
    if (node.value) result.push({ text: node.value, color: inheritedColor });
    return;
  }
  const classes: string[] = node.properties?.className ?? [];
  const className = classes.map((item: string) => item.replace(/^hljs-/, '')).find((item: string) => tokenColors[item]);
  const color = className ? tokenColors[className]! : inheritedColor;
  const bold = classes.some((item: string) => ['hljs-keyword', 'hljs-title', 'hljs-built_in'].includes(item));
  for (const child of node.children ?? []) flatten(child, color, result);
  if (bold && result.length) result[result.length - 1] = { ...result[result.length - 1]!, bold: true };
}

export function renderHighlightedLine(line: string, language: string, baseColor: string): React.ReactNode {
  if (language === 'text' || !highlighter.registered(language)) return line;
  try {
    const tree = highlighter.highlight(language, line);
    const tokens: Array<{ text: string; color: string; bold?: boolean; italic?: boolean }> = [];
    for (const child of tree.children) flatten(child, baseColor, tokens);
    if (tokens.length === 0) return line;
    return tokens.map((token, index) => (
      <PdfText key={index} style={{ color: token.color, ...(token.bold ? { fontWeight: 700 } : {}), ...(token.italic ? { fontStyle: 'italic' } : {}) }}>{token.text}</PdfText>
    ));
  } catch {
    return line;
  }
}
