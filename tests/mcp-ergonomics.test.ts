import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPdfMcpServer } from '../src/server.js';
import { componentCatalog } from '../src/components/catalog.js';
import { getComponentSchema, invalidateComponentSchemaCache } from '../src/engine/validate.js';
import { inspectPdfDocument } from '../src/tools/inspectPdf.js';
import { generatePdf } from '../src/tools/generatePdf.js';
import { generatePdfInputSchema } from '../src/schemas/ast.js';
import { buildWorkspace } from '../src/runtime/workspace.js';

test('MCP server exposes 8 annotated tools, MCP resources, and MCP prompts for AI agents', async () => {
  const server = createPdfMcpServer();
  const client = new Client({ name: 'ergonomics-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const toolsRes = await client.listTools();
    const names = toolsRes.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'apply_pdf_security',
      'generate_pdf',
      'get_pdf_server_info',
      'inspect_pdf',
      'list_pdf_components',
      'list_pdfs',
      'merge_pdfs',
      'validate_pdf_ast'
    ]);

    const readOnlyNames = new Set(['get_pdf_server_info', 'list_pdf_components', 'validate_pdf_ast', 'inspect_pdf', 'list_pdfs']);
    for (const tool of toolsRes.tools) {
      assert.ok(tool.annotations, `Expected annotations on ${tool.name}`);
      assert.equal(tool.annotations.readOnlyHint, readOnlyNames.has(tool.name), `Unexpected readOnlyHint on ${tool.name}`);
    }

    const resourcesRes = await client.listResources();
    const uris = resourcesRes.resources.map((r) => r.uri);
    assert.ok(uris.includes('pdf://guide/workflow'));
    assert.ok(uris.includes('pdf://examples/monthly-sales-report'));
    assert.ok(uris.includes('pdf://examples/invoice'));

    const guide = await client.readResource({ uri: 'pdf://guide/workflow' });
    const guideText = 'text' in guide.contents[0]! ? guide.contents[0]!.text : '';
    assert.match(guideText, /inspect_pdf|Markdown/);

    const promptsRes = await client.listPrompts();
    const promptNames = promptsRes.prompts.map((p) => p.name);
    assert.ok(promptNames.includes('executive-report'));
    assert.ok(promptNames.includes('technical-spec'));
    assert.ok(promptNames.includes('commercial-proposal'));
    assert.ok(promptNames.includes('invoice'));

    const prompt = await client.getPrompt({ name: 'executive-report', arguments: { topic: 'FinOps 2026' } });
    const promptText = prompt.messages[0]?.content.type === 'text' ? prompt.messages[0].content.text : '';
    assert.match(promptText, /FinOps 2026/);
    assert.match(promptText, /CoverPage|MetricCard|Markdown/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('componentCatalog covers all 27 AST components and JSON Schema carries field descriptions', () => {
  assert.equal(componentCatalog.length, 27);
  const names = new Set(componentCatalog.map((c) => c.name));
  for (const expected of ['Badge', 'Timeline', 'Quote', 'CoverPage', 'TableOfContents', 'Markdown', 'Section']) {
    assert.ok(names.has(expected as any), `Missing ${expected} in componentCatalog`);
  }

  invalidateComponentSchemaCache();
  const schema = getComponentSchema() as { properties?: Record<string, { description?: string }> };
  assert.ok(schema.properties?.filename?.description, 'Expected description on filename in JSON Schema');
  assert.ok(schema.properties?.content?.description, 'Expected description on content in JSON Schema');
});

test('generatePdf returns section outline telemetry and inspectPdfDocument detects sparse trailing pages', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-pdf-ergo-'));
  try {
    const ws = buildWorkspace([tmpDir], { outputDirSetting: tmpDir, extraAllowedDirs: [], allowAnyPath: false });
    const doc = generatePdfInputSchema.parse({
      filename: 'telemetry-check',
      overwrite: true,
      content: [
        { type: 'SectionTitle', title: 'Overview', level: 1, autoNumber: true },
        { type: 'Text', text: Array(25).fill('Substantial paragraph content filling page one cleanly for density testing.').join(' ') },
        { type: 'PageBreak' },
        { type: 'Text', text: 'Tiny orphan.' }
      ]
    });

    const gen = await generatePdf(doc, ws, { preParsed: true });
    assert.equal(gen.pages, 2);
    assert.ok(Array.isArray(gen.outline) && gen.outline.length === 1);

    const inspection = await inspectPdfDocument({ filePath: String(gen.path) }, ws);
    assert.equal(inspection.pages, 2);
    const warnings = inspection.layoutWarnings as Array<{ code: string }>;
    assert.ok(warnings.some((w) => w.code === 'SPARSE_TRAILING_PAGE'), `Expected SPARSE_TRAILING_PAGE in ${JSON.stringify(warnings)}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
