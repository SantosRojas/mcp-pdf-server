import test from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { splitInlineMarkup } from '../src/engine/inlineMarkup.js';
import { tokenizeCodeLines } from '../src/engine/codeHighlighter.js';
import { formatCell, renderPdf, resolveChildWidths } from '../src/engine/render.js';
import { generatePdfInputSchema } from '../src/schemas/ast.js';
import { invalidateComponentSchemaCache, validatePdfAst } from '../src/engine/validate.js';

async function extractPagesText(pdfBytes: Buffer): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: false, isEvalSupported: false });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  await task.destroy();
  return pages;
}

test('resolveChildWidths computes weighted Grid column widths and validates weights length', () => {
  const widths = resolveChildWidths(500, 2, 20, [2, 1]);
  assert.deepEqual(widths.map((w) => Math.round(w)), [320, 160]);

  invalidateComponentSchemaCache();
  const badGrid = validatePdfAst({
    filename: 'bad-weights',
    content: [{ type: 'Grid', columns: 2, weights: [1, 2, 3], children: [{ type: 'Text', text: 'A' }] }]
  });
  assert.equal(badGrid.valid, false);
});

test('formatCell parses ISO YYYY-MM-DD calendar dates without UTC negative-offset day shift', () => {
  const formatted = formatCell('2026-11-17', 'date', 'USD', 'en-US');
  assert.match(formatted, /\b17\b/);
  assert.doesNotMatch(formatted, /\b16\b/);
});

test('splitInlineMarkup supports *italic* and [label](https://...) links while preserving SNAKE_CASE identifiers', () => {
  const runs = splitInlineMarkup('Check *urgent* **KPI_TOTAL** `npm test` at [Portal](https://example.com/report) with STATE_OK.');
  assert.ok(runs.some((r) => r.kind === 'italic' && r.text === 'urgent'));
  assert.ok(runs.some((r) => r.kind === 'bold' && r.text === 'KPI_TOTAL'));
  assert.ok(runs.some((r) => r.kind === 'code' && r.text === 'npm test'));
  assert.ok(runs.some((r) => r.kind === 'link' && r.text === 'Portal' && r.href === 'https://example.com/report'));
  assert.ok(runs.some((r) => r.kind === 'text' && r.text.includes('STATE_OK')));
});

test('tokenizeCodeLines highlights multi-line comments across line boundaries and supports expanded languages', () => {
  const parsed = generatePdfInputSchema.parse({
    filename: 'go-code',
    content: [{ type: 'CodeBlock', language: 'go', code: '/* multi\n   comment */\nfunc main() {}' }]
  });
  assert.equal((parsed.content[0] as { language: string }).language, 'go');

  const lines = tokenizeCodeLines('/* first line\n   second line */\nconst x = 1;', 'javascript', '#24292F', false);
  assert.equal(lines.length, 3);
  assert.ok(lines[1]!.every((span) => span.italic === true), 'Continuation of block comment must remain italic comment');
});

test('renderPdf supports settings.locale, skipFirstPage chrome, hierarchical SectionTitle, horizontalBar, pie shares, and tall Callout wrapping', async () => {
  const longCallout = Array.from({ length: 75 }, (_, i) => `Paragraph line ${i + 1} inside an extended executive callout block that exceeds a single page.`).join('\n');
  const doc = generatePdfInputSchema.parse({
    filename: 'layout-suite',
    settings: { locale: 'en-US', margins: { top: 48, bottom: 48, left: 40, right: 64 } },
    fixedHeader: { text: 'CONFIDENTIAL RUNNING HEADER', skipFirstPage: true },
    fixedFooter: { showPageNumbers: true, skipFirstPage: true },
    content: [
      { type: 'SectionTitle', title: 'Architecture', level: 1, autoNumber: true },
      { type: 'SectionTitle', title: 'Submodule A', level: 2, autoNumber: true },
      { type: 'SectionTitle', title: 'Detail A1', level: 3, autoNumber: true },
      { type: 'SectionTitle', title: 'Operations', level: 1, autoNumber: true },
      {
        type: 'Grid',
        columns: 2,
        weights: [2, 1],
        children: [
          { type: 'Chart', chartType: 'horizontalBar', title: 'Regional Revenue', labels: ['North America Enterprise', 'LATAM Commercial'], datasets: [{ label: 'Q4', data: [420, 180] }] },
          { type: 'Chart', chartType: 'doughnut', title: 'Mix', labels: ['Cloud', 'OnPrem'], datasets: [{ label: 'Share', data: [75, 25] }] }
        ]
      },
      { type: 'InvoiceSummary', currency: 'USD', locale: 'en-US', subtotal: 1000, tax: 180, discount: 0, total: 1180, notes: 'Pay via [Stripe](https://stripe.com)' },
      { type: 'Callout', variant: 'info', title: 'Extended Appendix Note', content: longCallout }
    ]
  });

  const rendered = await renderPdf(doc);
  assert.ok(rendered.pageCount >= 2, 'Tall Callout should wrap onto page 2+ instead of clipping');
  const pages = await extractPagesText(rendered.bytes);

  assert.doesNotMatch(pages[0]!, /CONFIDENTIAL RUNNING HEADER/);
  assert.doesNotMatch(pages[0]!, /Page 1 of/);
  assert.match(pages[1]!, /CONFIDENTIAL RUNNING HEADER/);
  assert.match(pages[1]!, /Page 2 of/);

  const joined = pages.join(' ');
  assert.match(joined, /1\.1\./);
  assert.match(joined, /1\.1\.1\./);
  assert.match(joined, /2\./);
  assert.match(joined, /75%/);
  assert.match(joined, /Tax/);
});
