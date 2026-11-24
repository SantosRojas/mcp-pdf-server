import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { clearImageCache, getImageCacheStats, processImageSource } from '../src/engine/imageProcessor.js';
import { catalogForCategory, getComponentSchema, validatePdfAst } from '../src/engine/validate.js';
import { generatePdf } from '../src/tools/generatePdf.js';
import { generatePdfInputSchema } from '../src/schemas/ast.js';
import { buildWorkspace } from '../src/runtime/workspace.js';

test('processImageSource preserves JPEG format instead of inflating to PNG and caches repeated payloads', async () => {
  clearImageCache();
  const jpegRaw = await sharp({
    create: { width: 120, height: 80, channels: 3, background: { r: 30, g: 90, b: 160 } }
  }).jpeg({ quality: 85 }).toBuffer();
  const dataUri = `data:image/jpeg;base64,${jpegRaw.toString('base64')}`;

  const first = await processImageSource(dataUri);
  // JPEG magic bytes FF D8 FF
  assert.equal(first[0], 0xff);
  assert.equal(first[1], 0xd8);
  assert.equal(first[2], 0xff);
  assert.equal(getImageCacheStats().entries, 1);
  assert.equal(getImageCacheStats().hits, 0);

  const second = await processImageSource(dataUri);
  assert.equal(Buffer.compare(first, second), 0);
  assert.equal(getImageCacheStats().hits, 1);

  // Unsafe SVG with script is still rejected via header check + full SVG scan
  const unsafeSvgUri = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
  await assert.rejects(() => processImageSource(unsafeSvgUri), /UNSAFE_SVG|scripts/i);
});

test('getComponentSchema is memoized and catalogForCategory omits full schema for single-category queries unless requested', () => {
  const s1 = getComponentSchema();
  const s2 = getComponentSchema();
  assert.strictEqual(s1, s2);

  const filtered = catalogForCategory('data') as Record<string, unknown>;
  assert.equal('schema' in filtered, false);

  const filteredWithSchema = catalogForCategory('data', true) as Record<string, unknown>;
  assert.strictEqual(filteredWithSchema.schema, s1);

  const all = catalogForCategory('all') as Record<string, unknown>;
  assert.strictEqual(all.schema, s1);
});

test('validatePdfAst enforces unique image/QR limits and warns on InvoiceSummary arithmetic mismatch or missing local asset', () => {
  const tooManyImages = Array.from({ length: 41 }, (_, i) => ({
    type: 'Image',
    src: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==${i}`
  }));
  const imgResult = validatePdfAst({ filename: 'many-images', content: tooManyImages });
  assert.equal(imgResult.valid, false);
  assert.ok(imgResult.errors.some((e) => e.code === 'IMAGE_COUNT_LIMIT'));

  const tooManyQrs = Array.from({ length: 101 }, (_, i) => ({ type: 'QRCode', value: `https://example.com/${i}` }));
  const qrResult = validatePdfAst({ filename: 'many-qrs', content: tooManyQrs });
  assert.equal(qrResult.valid, false);
  assert.ok(qrResult.errors.some((e) => e.code === 'QR_COUNT_LIMIT'));

  const invoiceMismatch = validatePdfAst({
    filename: 'inv-mismatch',
    content: [
      { type: 'InvoiceSummary', subtotal: 100, tax: 18, discount: 10, total: 999 },
      { type: 'Image', src: 'non-existent-local-logo-xyz.png' }
    ]
  });
  assert.equal(invoiceMismatch.valid, true);
  assert.ok(invoiceMismatch.warnings.some((w) => w.code === 'INVOICE_TOTAL_MISMATCH'));
  assert.ok(invoiceMismatch.warnings.some((w) => w.code === 'IMAGE_ASSET_MISSING'));
});

test('generatePdf embeds code attachment in single render pass without corrupting page count', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-pdf-perf-'));
  try {
    const ws = buildWorkspace([tmpDir], { outputDirSetting: tmpDir, extraAllowedDirs: [], allowAnyPath: false });
    const parsed = generatePdfInputSchema.parse({
      filename: 'embedded-code',
      overwrite: true,
      settings: { codeExport: 'embedded' },
      content: [{ type: 'CodeBlock', language: 'typescript', code: 'export const x = 42;' }]
    });
    const out = await generatePdf(parsed, ws, { skipValidation: true });
    assert.equal(out.pages, 1);
    assert.ok(Array.isArray(out.codeExports) && out.codeExports.length === 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
