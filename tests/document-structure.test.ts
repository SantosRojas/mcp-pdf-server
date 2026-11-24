import test from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { compileMarkdownToAst } from '../src/engine/markdownParser.js';
import { collectCodeBlocks } from '../src/engine/codeExport.js';
import { renderPdf } from '../src/engine/render.js';
import { generatePdfInputSchema } from '../src/schemas/ast.js';
import { invalidateComponentSchemaCache, validatePdfAst } from '../src/engine/validate.js';

async function inspectRenderedPages(pdfBytes: Buffer): Promise<Array<{ width: number; height: number; text: string }>> {
  const task = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: false, isEvalSupported: false });
  const pdf = await task.promise;
  const pages: Array<{ width: number; height: number; text: string }> = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
      text: content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
    });
  }
  await task.destroy();
  return pages;
}

test('compileMarkdownToAst deterministically compiles headings, alerts, lists, tables, quotes, and code blocks without HTML execution', () => {
  const md = [
    '# Executive Summary',
    '',
    'Revenue grew **28% YoY** across enterprise accounts.',
    '',
    '> [!WARNING] Latency SLA',
    '> Keep P99 below `150ms` in multi-region clusters.',
    '',
    '- [x] Enable TLS 1.3',
    '- [ ] Complete DR drill',
    '',
    '| Region | ARR |',
    '| :--- | ---: |',
    '| NA | $1.2M |',
    '| EMEA | $850k |',
    '',
    '```typescript',
    'export const ready = true;',
    '```'
  ].join('\n');

  const ast = compileMarkdownToAst(md);
  const types = ast.map((n) => n.type);
  assert.deepEqual(types, ['SectionTitle', 'Text', 'Callout', 'BulletList', 'DataTable', 'CodeBlock']);

  // Code export also discovers fenced blocks inside Markdown nodes
  const exported = collectCodeBlocks([{ type: 'Markdown', markdown: md }]);
  assert.equal(exported.length, 1);
  assert.equal(exported[0]?.language, 'typescript');
});

test('renders CoverPage, auto TableOfContents, Watermark, Markdown, and mixed portrait + landscape Section appendix', async () => {
  invalidateComponentSchemaCache();
  const rawDoc = {
    filename: 'board-deck-report',
    settings: {
      locale: 'en-US',
      watermark: { text: 'CONFIDENTIAL', opacity: 0.08 }
    },
    fixedHeader: { text: 'BOARD REPORT Q4' },
    fixedFooter: { showPageNumbers: true },
    content: [
      {
        type: 'CoverPage',
        eyebrow: 'ANNUAL ARCHITECTURE REVIEW',
        title: 'Platform Modernization 2026',
        subtitle: 'Reliability, Security & AI Agent Workflows',
        meta: [
          { label: 'Prepared by', value: 'Principal Architecture' },
          { label: 'Classification', value: 'Board Confidential' }
        ],
        footerNote: 'Fiscal Year 2026'
      },
      { type: 'TableOfContents', title: 'Contents' },
      {
        type: 'Markdown',
        markdown: '## Cloud Topology\n\nAll workloads run on **zero-trust** meshes.\n\n### Edge Ingress\n\nProtected via `net.BlockList`.'
      },
      {
        type: 'Section',
        orientation: 'landscape',
        children: [
          { type: 'SectionTitle', title: 'Wide Financial Matrix', level: 1, autoNumber: true },
          {
            type: 'DataTable',
            columns: [
              { key: 'q1', label: 'Q1' },
              { key: 'q2', label: 'Q2' },
              { key: 'q3', label: 'Q3' },
              { key: 'q4', label: 'Q4' }
            ],
            rows: [{ q1: '100', q2: '120', q3: '140', q4: '180' }]
          }
        ]
      }
    ]
  };

  const validation = validatePdfAst(rawDoc);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));

  const parsed = generatePdfInputSchema.parse(rawDoc);
  const rendered = await renderPdf(parsed);
  assert.ok(rendered.pageCount >= 3);

  const pages = await inspectRenderedPages(rendered.bytes);
  // Page 1: CoverPage (portrait: width < height, suppresses fixedHeader)
  assert.ok(pages[0]!.width < pages[0]!.height);
  assert.match(pages[0]!.text, /Platform Modernization 2026/);
  assert.doesNotMatch(pages[0]!.text, /BOARD REPORT Q4/);

  // Body page: TableOfContents lists both Markdown headings and Section headings, plus Watermark
  const bodyText = pages.slice(1).map((p) => p.text).join(' ');
  assert.match(bodyText, /Contents/);
  assert.match(bodyText, /Cloud Topology/);
  assert.match(bodyText, /Wide Financial Matrix/);
  assert.match(bodyText, /CONFIDENTIAL/);

  // Last page: Landscape Section (width > height!)
  const lastPage = pages[pages.length - 1]!;
  assert.ok(lastPage.width > lastPage.height, `Expected landscape page width (${lastPage.width}) > height (${lastPage.height})`);
});
