import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  CODE_BASE_FONT_SIZE, CODE_MIN_FONT_SIZE, codeGutterWidth, computeCodeMetrics, expandTabs, normalizeCodeLines, wrapCodeLine
} from '../src/engine/codeMetrics.js';
import { computeGutterGeometry } from '../src/engine/codeGutter.js';
import { buildCodeMarkdown, codeSidecarPath, collectCodeBlocks } from '../src/engine/codeExport.js';
import { generatePdfInputSchema } from '../src/schemas/ast.js';
import { generatePdf } from '../src/tools/generatePdf.js';

const codeDocument = {
  filename: 'code-block-copy',
  content: [{
    type: 'CodeBlock',
    language: 'sql',
    code: 'SELECT a FROM tabla;\nSELECT b FROM otra;\nSELECT c FROM tercera;'
  }]
};

async function extractText(bytes: Uint8Array): Promise<string> {
  const task = getDocument({ data: bytes, useSystemFonts: false, isEvalSupported: false });
  const pdf = await task.promise;
  const parts: string[] = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    for (const item of content.items) parts.push('str' in item ? item.str : '');
  }
  await task.destroy();
  return parts.join('');
}

test('normalizeCodeLines expands tabs and normalizes line endings', () => {
  assert.deepEqual(normalizeCodeLines('a\r\nb\rc'), ['a', 'b', 'c']);
  assert.equal(expandTabs('\tx'), '    x');
  assert.equal(expandTabs('ab\tx'), 'ab  x');
});

test('computeCodeMetrics shrinks the font before wrapping long lines', () => {
  const long = 'x'.repeat(200);
  const fitted = computeCodeMetrics([long], 300, 'fit');
  assert.ok(fitted.fontSize < CODE_BASE_FONT_SIZE);
  assert.ok(fitted.fontSize >= CODE_MIN_FONT_SIZE);
  const soft = computeCodeMetrics([long], 300, 'soft');
  assert.equal(soft.fontSize, CODE_BASE_FONT_SIZE);
  assert.ok(soft.columns < 200);
  const short = computeCodeMetrics(['SELECT 1'], 300);
  assert.equal(short.fontSize, CODE_BASE_FONT_SIZE);
});

test('wrapCodeLine never injects indentation on continuation rows', () => {
  const line = `${' '.repeat(4)}const value = someFunction(argumentOne, argumentTwo, argumentThree, argumentFour, argumentFive);`;
  const segments = wrapCodeLine(line, 40);
  assert.ok(segments.length > 1);
  assert.equal(segments[0], line.slice(0, 40).trimEnd());
  for (const segment of segments.slice(1)) assert.equal(segment, segment.trimStart());
  // Only whitespace at the break point may be lost; nothing is invented.
  assert.ok(line.startsWith(segments[0] ?? ''));
});

test('codeGutterWidth grows with the number of digits', () => {
  assert.ok(codeGutterWidth(999) <= codeGutterWidth(1000));
  assert.equal(codeGutterWidth(5), codeGutterWidth(9));
});

test('gutter geometry is valid vector data for every digit and the continuation marker', () => {
  for (const value of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99, 1234, 'continuation'] as const) {
    const geometry = computeGutterGeometry(value, 26, 7.4);
    assert.ok(geometry.width > 0 && geometry.height > 0 && geometry.strokeWidth > 0);
    assert.match(geometry.d, /^M[\d.]+ [\d.]+/);
    assert.doesNotMatch(geometry.d, /NaN|Infinity|undefined/);
    // Everything stays inside the gutter box.
    const numbers = geometry.d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    assert.ok(numbers.every((value) => Number.isFinite(value) && value >= -1 && value <= geometry.width + 1));
  }
});

test('collectCodeBlocks finds nested blocks and builds escaped markdown fences', () => {
  const blocks = collectCodeBlocks([
    { type: 'View', children: [{ type: 'CodeBlock', language: 'bash', code: 'echo hi' }] },
    { type: 'CodeBlock', title: 'Fence', code: 'a\n```\nb' }
  ]);
  assert.equal(blocks.length, 2);
  const markdown = buildCodeMarkdown(blocks, 'Informe');
  assert.match(markdown, /```bash\necho hi\n```/);
  assert.match(markdown, /````text[\s\S]*````/);
  assert.equal(codeSidecarPath(path.join('out', 'informe.pdf')), path.join('out', 'informe.code.md'));
});

test('copying a code block from the PDF no longer carries the line numbers', async () => {
  const parsed = generatePdfInputSchema.parse({ ...codeDocument, outputDir: '.', filename: `copy-check-${process.pid}` });
  const { renderPdf } = await import('../src/engine/render.js');
  const rendered = await renderPdf(parsed);
  const text = await extractText(new Uint8Array(rendered.bytes));
  assert.match(text, /SELECT a FROM tabla;/);
  // With the vector gutter there is no digit anywhere in the page text layer.
  assert.doesNotMatch(text, /\d/);
});

test('JetBrains Mono disables programming ligatures so operators copy as literal ASCII', async () => {
  const parsed = generatePdfInputSchema.parse({
    filename: `ligature-check-${process.pid}`,
    content: [
      {
        type: 'Text',
        text: 'Comparación inline: `a <= b && c <> d && e != f && g => h`'
      },
      {
        type: 'CodeBlock',
        language: 'sql',
        code: 'SELECT * FROM dbo.Ventas WHERE total <= 100 AND estado <> 0 AND margen >= 10 AND tipo != 2; -- comentario'
      }
    ]
  });
  const { renderPdf } = await import('../src/engine/render.js');
  const rendered = await renderPdf(parsed);
  const text = await extractText(new Uint8Array(rendered.bytes));
  assert.ok(text.includes('<='), `expected literal <= in extracted text: ${text}`);
  assert.ok(text.includes('<>'), `expected literal <> in extracted text: ${text}`);
  assert.ok(text.includes('>='), `expected literal >= in extracted text: ${text}`);
  assert.ok(text.includes('!='), `expected literal != in extracted text: ${text}`);
  assert.ok(text.includes('=>'), `expected literal => in extracted text: ${text}`);
  assert.ok(text.includes('--'), `expected literal -- in extracted text: ${text}`);
});

test('lineNumberStyle=text keeps the legacy selectable gutter', async () => {
  const parsed = generatePdfInputSchema.parse({
    ...codeDocument,
    filename: 'copy-check-text',
    content: [{ ...codeDocument.content[0], lineNumberStyle: 'text', showLineNumbers: true }]
  });
  const { renderPdf } = await import('../src/engine/render.js');
  const rendered = await renderPdf(parsed);
  const text = await extractText(new Uint8Array(rendered.bytes));
  assert.match(text, /1/);
});

test('codeExport="sidecar" writes a markdown companion and embeds the attachment', async () => {
  const filename = `code-export-${process.pid}`;
  const result = await generatePdf(generatePdfInputSchema.parse({
    ...codeDocument,
    filename,
    overwrite: true,
    settings: { codeExport: 'both' }
  })) as { path: string; codeExports?: Array<{ kind: string; path?: string }>; warnings: string[] };
  const sidecar = `${path.join(path.dirname(result.path), path.basename(result.path, '.pdf'))}.code.md`;
  try {
    assert.ok(result.codeExports?.some((entry) => entry.kind === 'sidecar' && entry.path === sidecar));
    assert.ok(result.codeExports?.some((entry) => entry.kind === 'embedded'));
    const markdown = await fs.readFile(sidecar, 'utf8');
    assert.match(markdown, /SELECT a FROM tabla;/);
    assert.doesNotMatch(markdown, /^\s*1\s+SELECT/m);
    const pdf = await PDFDocument.load(await fs.readFile(result.path));
    const names = pdf.catalog.get(PDFName.of('Names'));
    const namesDict = pdf.context.lookup(names) as PDFDict | undefined;
    assert.ok(namesDict instanceof PDFDict, 'expected a /Names dictionary');
    assert.ok(namesDict.has(PDFName.of('EmbeddedFiles')), 'expected an embedded source file');
  } finally {
    await fs.rm(result.path, { force: true });
    await fs.rm(sidecar, { force: true });
  }
});
