import path from 'node:path';
import { compileMarkdownToAst } from './markdownParser.js';

/**
 * Exact-source export for CodeBlock components.
 *
 * A PDF text layer cannot preserve code faithfully: wrapped rows become hard line breaks and
 * the viewer decides where a "line" ends. The pieces that matter for copy/paste therefore come
 * from the AST, written as a companion file and/or embedded as an attachment.
 */

export interface CodeBlockSource {
  /** 1-based position among the document's code blocks. */
  index: number;
  title?: string;
  language: string;
  code: string;
}

/** Collects every CodeBlock, including the ones nested inside View/Grid containers. */
export function collectCodeBlocks(content: readonly unknown[], found: CodeBlockSource[] = []): CodeBlockSource[] {
  for (const node of content) {
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    if (record.type === 'CodeBlock' && typeof record.code === 'string') {
      const block: CodeBlockSource = {
        index: found.length + 1,
        language: typeof record.language === 'string' && record.language.trim() ? record.language : 'text',
        code: record.code
      };
      if (typeof record.title === 'string' && record.title.trim()) block.title = record.title;
      found.push(block);
    }
    if (record.type === 'Markdown' && typeof record.markdown === 'string') {
      collectCodeBlocks(compileMarkdownToAst(record.markdown), found);
      continue;
    }
    for (const key of ['children', 'content']) {
      const nested = record[key];
      if (Array.isArray(nested)) collectCodeBlocks(nested, found);
    }
  }
  return found;
}

/** Markdown export: fenced blocks keep the language so editors highlight them on paste. */
export function buildCodeMarkdown(blocks: readonly CodeBlockSource[], documentTitle: string): string {
  const parts: string[] = [
    `# Código fuente — ${documentTitle}`,
    '',
    `Copia exacta de ${blocks.length} bloque(s) de código del documento: sin numeración de línea y sin los saltos que agrega el ajuste visual.`,
    ''
  ];
  for (const block of blocks) {
    const heading = block.title ? `${block.index}. ${block.title}` : `${block.index}. Bloque ${block.language}`;
    const body = block.code.replace(/\r\n?/g, '\n');
    const fence = body.includes('```') ? '````' : '```';
    parts.push(`## ${heading}`, '', `${fence}${block.language}`, body, fence, '');
  }
  return parts.join('\n');
}

/** `<output>/informe.pdf` -> `<output>/informe.code.md` */
export function codeSidecarPath(pdfPath: string): string {
  const directory = path.dirname(pdfPath);
  const base = path.basename(pdfPath, path.extname(pdfPath));
  return path.join(directory, `${base}.code.md`);
}
