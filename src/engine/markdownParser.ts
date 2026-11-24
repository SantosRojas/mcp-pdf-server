import type { ComponentNode } from '../schemas/ast.js';

const CODE_LANG_MAP: Record<string, string> = {
  sql: 'sql',
  python: 'python', py: 'python',
  json: 'json', jsonc: 'json',
  javascript: 'javascript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  typescript: 'typescript', ts: 'typescript', tsx: 'typescript',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  yaml: 'yaml', yml: 'yaml',
  text: 'text', txt: 'text', plain: 'text',
  go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust',
  java: 'java',
  csharp: 'csharp', cs: 'csharp',
  cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp',
  c: 'c', h: 'c',
  html: 'html',
  css: 'css',
  xml: 'xml', svg: 'xml',
  dockerfile: 'dockerfile', docker: 'dockerfile',
  graphql: 'graphql', gql: 'graphql',
  markdown: 'markdown', md: 'markdown',
  php: 'php',
  ruby: 'ruby', rb: 'ruby',
  swift: 'swift',
  kotlin: 'kotlin', kt: 'kotlin'
};

function sanitizeInlineHtml(line: string): string {
  // Strip raw HTML tags outside inline code spans so untrusted HTML never leaks or executes.
  const parts = line.split(/(`[^`]*`)/g);
  return parts
    .map((part) => (part.startsWith('`') && part.endsWith('`') ? part : part.replace(/<\/?[A-Za-z][^>\n]*>/g, '')))
    .join('');
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => sanitizeInlineHtml(cell.trim()));
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = splitTableCells(trimmed);
  return cells.length >= 1 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function parseTableAlign(spec: string): 'left' | 'center' | 'right' {
  if (spec.startsWith(':') && spec.endsWith(':')) return 'center';
  if (spec.endsWith(':')) return 'right';
  return 'left';
}

interface ParsedListItem {
  indent: number;
  text: string;
  checked?: boolean;
  ordered: boolean;
  children: ParsedListItem[];
}

const LIST_LINE_RE = /^(\s*)(?:([-*+])|(\d+)\.)\s+(?:\[([ xX])\]\s+)?(.+)$/;

/**
 * Deterministic Markdown-to-AST compiler for prose-heavy agent documents.
 * Converts headings, paragraphs, GitHub-style alerts, blockquotes, nested/task lists,
 * GFM pipe tables, dividers, and fenced code blocks into strict AST ComponentNodes.
 */
export function compileMarkdownToAst(markdown: string): ComponentNode[] {
  const cleaned = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const lines = cleaned.split('\n');
  const nodes: ComponentNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block (``` or ````)
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})([^\s`~]*)(?:\s+(.*))?$/);
    if (fenceMatch) {
      const fence = fenceMatch[1]!;
      const rawLang = (fenceMatch[2] ?? '').toLowerCase();
      const title = fenceMatch[3]?.trim();
      const language = (CODE_LANG_MAP[rawLang] ?? 'text') as any;
      i += 1;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i]!.trim().startsWith(fence)) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      nodes.push({
        type: 'CodeBlock',
        code: codeLines.join('\n'),
        language,
        ...(title ? { title: title.slice(0, 200) } : {}),
        showLineNumbers: true,
        lineNumberStyle: 'vector',
        wrap: 'fit',
        theme: 'light'
      } as ComponentNode);
      continue;
    }

    // Horizontal rule
    if (/^(?:-\s*){3,}$|^(?:\*\s*){3,}$|^(?:_\s*){3,}$/.test(trimmed)) {
      nodes.push({ type: 'Divider', color: '#D9DEE7', thickness: 1, style: 'solid', margin: 8 } as ComponentNode);
      i += 1;
      continue;
    }

    // ATX Heading (# .. ######)
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (headingMatch) {
      const hashes = headingMatch[1]!.length;
      const level = (hashes === 1 ? 1 : hashes === 2 ? 2 : 3) as 1 | 2 | 3;
      const title = sanitizeInlineHtml(headingMatch[2]!).slice(0, 300);
      if (title) {
        nodes.push({
          type: 'SectionTitle',
          title,
          level,
          autoNumber: false,
          underline: level === 1,
          bookmark: true
        } as ComponentNode);
      }
      i += 1;
      continue;
    }

    // Blockquote or GitHub Alert (> [!NOTE] ...)
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quoteLines.push(sanitizeInlineHtml(lines[i]!.trim().replace(/^>\s?/, '')));
        i += 1;
      }
      const first = quoteLines[0] ?? '';
      const alertMatch = first.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (alertMatch) {
        const kind = alertMatch[1]!.toUpperCase();
        const inlineTitle = alertMatch[2]?.trim();
        const variant = kind === 'TIP'
          ? 'success'
          : kind === 'WARNING'
            ? 'warning'
            : kind === 'CAUTION'
              ? 'danger'
              : 'info';
        const body = quoteLines.slice(1).join('\n').trim() || inlineTitle || kind;
        nodes.push({
          type: 'Callout',
          variant,
          ...(inlineTitle && quoteLines.length > 1 ? { title: inlineTitle.slice(0, 200) } : {}),
          content: body.slice(0, 50_000)
        } as ComponentNode);
      } else {
        const text = quoteLines.join('\n').trim();
        if (text) {
          nodes.push({ type: 'Quote', text: text.slice(0, 50_000) } as ComponentNode);
        }
      }
      continue;
    }

    // GFM Pipe Table
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const headers = splitTableCells(rawLine).slice(0, 20);
      const aligns = splitTableCells(lines[i + 1]!).map(parseTableAlign);
      i += 2;
      const columns = headers.map((label, colIdx) => ({
        key: `col_${colIdx}`,
        label: (label || `Col ${colIdx + 1}`).slice(0, 100),
        align: aligns[colIdx] ?? 'left',
        format: 'text' as const
      }));
      const rows: Array<Record<string, string>> = [];
      while (i < lines.length && lines[i]!.trim().includes('|') && lines[i]!.trim() !== '') {
        const values = splitTableCells(lines[i]!);
        const row: Record<string, string> = {};
        columns.forEach((col, colIdx) => {
          row[col.key] = (values[colIdx] ?? '').slice(0, 2_000);
        });
        rows.push(row);
        i += 1;
        if (rows.length >= 3_000) break;
      }
      if (columns.length > 0) {
        nodes.push({
          type: 'DataTable',
          columns,
          rows,
          zebra: true,
          compact: false,
          currency: 'PEN',
          locale: 'es-PE'
        } as ComponentNode);
      }
      continue;
    }

    // Bullet / Ordered / Task List
    if (LIST_LINE_RE.test(rawLine)) {
      const rootItems: ParsedListItem[] = [];
      const stack: ParsedListItem[] = [];
      let hasCheckbox = false;
      let topOrdered = false;

      while (i < lines.length) {
        const m = lines[i]!.match(LIST_LINE_RE);
        if (!m) break;
        const indent = (m[1] ?? '').replace(/\t/g, '  ').length;
        const ordered = Boolean(m[3]);
        const checkChar = m[4];
        const itemText = sanitizeInlineHtml(m[5]!.trim()).slice(0, 2_000);
        if (checkChar !== undefined) hasCheckbox = true;
        if (rootItems.length === 0 && stack.length === 0) topOrdered = ordered;

        const item: ParsedListItem = {
          indent,
          text: itemText,
          ...(checkChar !== undefined ? { checked: checkChar.toLowerCase() === 'x' } : {}),
          ordered,
          children: []
        };

        while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
          stack.pop();
        }
        if (stack.length === 0) rootItems.push(item);
        else stack[stack.length - 1]!.children.push(item);
        stack.push(item);
        i += 1;
        if (rootItems.length >= 100) break;
      }

      const toAstItem = (entry: ParsedListItem): any => {
        if (entry.checked === undefined && entry.children.length === 0) return entry.text;
        return {
          text: entry.text,
          ...(entry.checked !== undefined ? { checked: entry.checked } : {}),
          ...(entry.children.length > 0 ? { children: entry.children.slice(0, 50).map(toAstItem) } : {})
        };
      };

      if (rootItems.length > 0) {
        nodes.push({
          type: 'BulletList',
          items: rootItems.map(toAstItem),
          ordered: topOrdered,
          ...(hasCheckbox ? { variant: 'check' } : {})
        } as ComponentNode);
      }
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (i < lines.length) {
      const line = lines[i]!;
      const t = line.trim();
      if (
        !t ||
        /^(`{3,}|~{3,})/.test(t) ||
        /^(#{1,6})\s+/.test(t) ||
        t.startsWith('>') ||
        LIST_LINE_RE.test(line) ||
        /^(?:-\s*){3,}$|^(?:\*\s*){3,}$|^(?:_\s*){3,}$/.test(t) ||
        (t.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!))
      ) {
        break;
      }
      paraLines.push(sanitizeInlineHtml(t));
      i += 1;
    }
    const paragraph = paraLines.join(' ').trim();
    if (paragraph) {
      nodes.push({
        type: 'Text',
        text: paragraph.slice(0, 50_000),
        size: 10,
        align: 'left',
        weight: 'normal',
        italic: false,
        lineHeight: 1.35,
        marginBottom: 6
      } as ComponentNode);
    }
  }

  return nodes;
}
