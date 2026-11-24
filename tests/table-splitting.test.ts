import test from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { renderPdf } from '../src/engine/render.js';
import { generatePdfInputSchema } from '../src/schemas/ast.js';
import { shouldSplitTable } from '../src/engine/tableLayout.js';

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

test('shouldSplitTable keeps small tables whole and lets large tables break', () => {
  assert.equal(shouldSplitTable(4, true), false, 'a 4-row table that fits must stay whole');
  assert.equal(shouldSplitTable(5, true), true, 'a 5-row table may break to fill the page');
  assert.equal(shouldSplitTable(3, false), true, 'a table taller than a page must break regardless of rows');
});

test('a large table starts on the current page, repeats its header, and does not leak it afterwards', async () => {
  const rows = Array.from({ length: 24 }, (_, i) => ({ a: `fila-${i}`, b: 'valor' }));
  const rendered = await renderPdf(
    generatePdfInputSchema.parse({
      filename: 'table-split',
      content: [
        { type: 'Text', text: 'Contexto previo que ocupa parte de la pagina. '.repeat(70) },
        {
          type: 'DataTable',
          columns: [
            { key: 'a', label: 'COLUMNA_A' },
            { key: 'b', label: 'COLUMNA_B' }
          ],
          rows,
          compact: true
        },
        { type: 'Text', text: 'Texto posterior a la tabla. '.repeat(400) }
      ]
    })
  );

  assert.ok(rendered.pageCount >= 3, 'the fixture must produce a page after the table');
  const pages = await extractPagesText(rendered.bytes);

  assert.match(pages[0]!, /COLUMNA_A/, 'the table must start on page 1 instead of jumping whole');
  assert.match(pages[0]!, /fila-0/);
  assert.match(pages[1]!, /COLUMNA_A/, 'the header must repeat on the continuation page');
  assert.match(pages[1]!, /fila-23/);
  assert.doesNotMatch(pages[2]!, /COLUMNA_A/, 'the fixed header must not leak past the table');
});
