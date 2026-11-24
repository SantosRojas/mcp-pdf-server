import test from 'node:test';
import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { renderPdf } from '../src/engine/render.js';
import { generatePdfInputSchema } from '../src/schemas/ast.js';
import { invalidateComponentSchemaCache, validatePdfAst } from '../src/engine/validate.js';

async function extractText(pdfBytes: Buffer): Promise<string> {
  const task = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: false, isEvalSupported: false });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  await task.destroy();
  return pages.join(' ');
}

test('accepts and renders Badge, Timeline, Quote, nested/check BulletList, DataTable badge/boolean/footerRow, and MetricCard sparkline', async () => {
  invalidateComponentSchemaCache();
  const rawDoc = {
    filename: 'pro-components',
    settings: { locale: 'en-US' },
    content: [
      { type: 'Badge', text: 'PRODUCTION READY', tone: 'success' },
      {
        type: 'MetricCard',
        label: 'Monthly Recurring Revenue',
        value: '$148,500',
        trend: '+14.2% MoM',
        sparkline: [95, 102, 110, 108, 124, 136, 148.5]
      },
      {
        type: 'Timeline',
        title: 'Q4 Rollout Roadmap',
        items: [
          { date: '2026-10-01', title: 'Security Audit', description: 'Completed SSRF & qpdf hardening', status: 'done' },
          { date: '2026-11-15', title: 'Canary Release', description: '10% enterprise traffic', status: 'active' },
          { date: '2026-12-01', title: 'GA Launch', status: 'pending' }
        ]
      },
      {
        type: 'Quote',
        text: 'Deterministic document structure beats raw HTML hallucinations every single time.',
        author: 'Principal Architecture Team',
        role: 'Platform Engineering'
      },
      {
        type: 'BulletList',
        variant: 'check',
        items: [
          { text: 'Zero-trust image pipeline', checked: true, children: ['IPv6 BlockList active', { text: 'SVG script sanitizer', checked: true }] },
          { text: 'Pending regional expansion', checked: false }
        ]
      },
      {
        type: 'DataTable',
        locale: 'en-US',
        currency: 'USD',
        columns: [
          { key: 'service', label: 'Service', format: 'text' },
          { key: 'status', label: 'Status', format: 'badge' },
          { key: 'verified', label: 'Verified', format: 'boolean' },
          { key: 'cost', label: 'Cost', format: 'currency', align: 'right' }
        ],
        rows: [
          { service: 'Core API', status: 'ACTIVE', verified: true, cost: 1200 },
          { service: 'Batch Worker', status: 'WARNING', verified: false, cost: 450 }
        ],
        footerRow: { service: 'Total Monthly', status: '', verified: null, cost: 1650 }
      }
    ]
  };

  const validation = validatePdfAst(rawDoc);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));

  const parsed = generatePdfInputSchema.parse(rawDoc);
  const rendered = await renderPdf(parsed);
  assert.equal(rendered.pageCount, 1);

  const text = await extractText(rendered.bytes);
  assert.match(text, /PRODUCTION READY/);
  assert.match(text, /Q4 Rollout Roadmap/);
  assert.match(text, /Canary Release/);
  assert.match(text, /Principal Architecture Team/);
  assert.match(text, /IPv6 BlockList active/);
  assert.match(text, /Total Monthly/);
  assert.match(text, /\$1,650\.00/);
  assert.match(text, /\bYes\b/);
  assert.match(text, /\bNo\b/);
});
