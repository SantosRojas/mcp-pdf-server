import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePdfInputSchema, securityPdfInputSchema, securityPdfToolInputSchema, validatePdfAstInputSchema } from '../src/schemas/ast.js';
import { getComponentSchema, validatePdfAst } from '../src/engine/validate.js';
import { computeFlowchartLayout, cyclicFlowchartEdges, wrapFlowchartText } from '../src/engine/flowchartLayout.js';
import { splitInlineMarkup } from '../src/engine/inlineMarkup.js';
import { flowchartPalette, luminance, metricValueSize, mix, readableText, withAlpha } from '../src/engine/design.js';
import { registerOptionalFonts, resolveTheme } from '../src/engine/themeProvider.js';
import { buildWorkspace, isPathAllowed } from '../src/runtime/workspace.js';
import { componentCatalog } from '../src/components/catalog.js';
import { safePdfFilename } from '../src/utils/files.js';
import { displayPath, expandHome, pathFromFileUri, splitPathList } from '../src/utils/paths.js';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const minimal = {
  filename: 'test-report',
  content: [{ type: 'Text', text: 'Hello **world**' }]
};

test('accepts a minimal document and applies defaults', () => {
  const parsed = generatePdfInputSchema.parse(minimal);
  assert.equal(parsed.settings.pageSize, 'A4');
  assert.equal(parsed.theme.preset, 'corporate_blue');
  assert.equal(parsed.content.length, 1);
});

test('rejects executable/unknown component properties', () => {
  const result = generatePdfInputSchema.safeParse({ ...minimal, content: [{ type: 'Text', text: 'x', onRender: 'process.exit(1)' }] });
  assert.equal(result.success, false);
});

test('rejects unsafe filenames', () => {
  assert.throws(() => safePdfFilename('../outside.pdf'));
  assert.throws(() => safePdfFilename('a/b'));
});

test('validates table schema and reports missing data fields as warnings', () => {
  const result = validatePdfAst({
    filename: 'table',
    content: [{ type: 'DataTable', columns: [{ key: 'sku', label: 'SKU' }], rows: [{ other: 'x' }] }]
  });
  assert.equal(result.valid, true);
  assert.equal(result.warnings.length, 1);
});

test('rejects chart datasets with a different number of values than labels', () => {
  const result = validatePdfAst({
    filename: 'chart',
    content: [{ type: 'Chart', chartType: 'bar', labels: ['Jan', 'Feb'], datasets: [{ label: 'Sales', data: [10] }] }]
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message ?? '', /cantidad de datos/);
});

test('catalogue has unique component names and required categories', () => {
  const names = componentCatalog.map((item) => item.name);
  assert.equal(new Set(names).size, names.length);
  for (const item of componentCatalog) assert.ok(['layout', 'data', 'technical', 'media', 'typography'].includes(item.category));
});


test('rejects duplicate DataTable column keys', () => {
  const result = validatePdfAst({
    filename: 'duplicate-columns',
    content: [{ type: 'DataTable', columns: [{ key: 'sku', label: 'SKU' }, { key: 'sku', label: 'SKU 2' }], rows: [] }]
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message ?? '', /key único/);
});

test('rejects CodeBlock with excessive line count', () => {
  const result = validatePdfAst({ filename: 'long-code', content: [{ type: 'CodeBlock', code: Array(2001).fill('SELECT 1;').join('\n') }] });
  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message ?? '', /2000 líneas/);
});


test('rejects an AST deeper than the configured structural limit', () => {
  let node: Record<string, unknown> = { type: 'Text', text: 'deep' };
  for (let index = 0; index < 35; index += 1) node = { type: 'View', children: [node] };
  const result = validatePdfAst({ filename: 'deep-tree', content: [node] });
  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message ?? '', /profundidad máxima/);
});

test('rejects negative values in pie charts', () => {
  const result = validatePdfAst({ filename: 'pie-negative', content: [{ type: 'Chart', chartType: 'pie', labels: ['A', 'B'], datasets: [{ label: 'Share', data: [10, -1] }] }] });
  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message ?? '', /valores negativos/);
});


test('requires an owner password when PDF permissions are restricted', () => {
  const invalid = securityPdfInputSchema.safeParse({ filePath: 'report.pdf', permissions: { printing: false, copying: true } });
  assert.equal(invalid.success, false);
  const shortPassword = securityPdfInputSchema.safeParse({ filePath: 'report.pdf', ownerPassword: '1234567', permissions: { printing: false, copying: true } });
  assert.equal(shortPassword.success, false);
  const valid = securityPdfInputSchema.safeParse({ filePath: 'report.pdf', ownerPassword: 'strong-owner-password', permissions: { printing: false, copying: true } });
  assert.equal(valid.success, true);
});


test('rejects unknown top-level document properties', () => {
  const result = validatePdfAst({ ...minimal, unexpected: 'must-not-be-silently-ignored' });
  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message ?? '', /Unrecognized key/);
});


test('security MCP schema is a strict object while semantic rules remain in validator', () => {
  assert.equal(typeof securityPdfToolInputSchema.safeParse, 'function');
  const shapeCheck = securityPdfToolInputSchema.safeParse({ filePath: 'file.pdf', unexpected: true });
  assert.equal(shapeCheck.success, false);
});


test('validate_pdf_ast accepts malformed document objects so it can report issues', () => {
  assert.equal(validatePdfAstInputSchema.safeParse({ filename: 42, content: 'not-an-array' }).success, true);
  const validation = validatePdfAst({ filename: 42, content: 'not-an-array' });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.length > 0);
});


test('exports a JSON Schema from the same AST contract', () => {
  const schema = getComponentSchema() as { type?: string; properties?: Record<string, unknown>; $schema?: string };
  assert.equal(schema.type, 'object');
  assert.ok(schema.properties && 'filename' in schema.properties && 'content' in schema.properties);
  assert.ok(schema.$schema?.includes('draft-07'));
});

test('rejects pie charts whose first dataset has no positive values', () => {
  const result = validatePdfAst({ filename: 'empty-pie', content: [{ type: 'Chart', chartType: 'pie', labels: ['A', 'B'], datasets: [{ label: 'Share', data: [0, 0] }] }] });
  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message ?? '', /al menos un valor positivo/);
});


test('accepts a Flowchart and applies direction and shape defaults', () => {
  const parsed = generatePdfInputSchema.parse({
    filename: 'flow',
    content: [{ type: 'Flowchart', nodes: [{ id: 'a', label: 'Inicio' }, { id: 'b', label: 'Fin', kind: 'end' }], edges: [{ from: 'a', to: 'b' }] }]
  });
  const node = parsed.content[0] as { direction: string; nodes: Array<{ kind: string }>; edges: Array<{ style: string }> };
  assert.equal(node.direction, 'vertical');
  assert.equal(node.nodes[0]?.kind, 'process');
  assert.equal(node.nodes[1]?.kind, 'end');
  assert.equal(node.edges[0]?.style, 'solid');
});

test('rejects Flowchart edges that point to unknown nodes', () => {
  const result = validatePdfAst({
    filename: 'flow-unknown',
    content: [{ type: 'Flowchart', nodes: [{ id: 'a', label: 'Inicio' }], edges: [{ from: 'a', to: 'ghost' }] }]
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0]?.message ?? '', /nodo inexistente/);
});

test('rejects Flowchart nodes with duplicated ids and self loops', () => {
  const duplicated = validatePdfAst({
    filename: 'flow-duplicate',
    content: [{ type: 'Flowchart', nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }]
  });
  assert.equal(duplicated.valid, false);
  assert.match(duplicated.errors[0]?.message ?? '', /id único/);
  const selfLoop = validatePdfAst({
    filename: 'flow-self',
    content: [{ type: 'Flowchart', nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'a' }] }]
  });
  assert.equal(selfLoop.valid, false);
  assert.match(selfLoop.errors[0]?.message ?? '', /hacia sí mismo/);
});

test('warns about Flowchart cycles instead of rejecting them', () => {
  const result = validatePdfAst({
    filename: 'flow-cycle',
    content: [{ type: 'Flowchart', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }]
  });
  assert.equal(result.valid, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]?.message ?? '', /arista/);
});

test('lays out a Flowchart chain in descending layers and routes each edge', () => {
  const layout = computeFlowchartLayout({
    width: 420,
    direction: 'vertical',
    nodes: [{ id: 'a', label: 'Recibir', kind: 'start' }, { id: 'b', label: 'Validar', kind: 'process' }, { id: 'c', label: 'Emitir', kind: 'end' }],
    edges: [{ from: 'a', to: 'b', style: 'solid' }, { from: 'b', to: 'c', style: 'solid' }]
  });
  assert.equal(layout.nodes.length, 3);
  assert.equal(layout.edges.length, 2);
  const [a, b, c] = layout.nodes;
  assert.ok(a && b && c);
  assert.ok(b.y > a.y && c.y > b.y);
  assert.ok(layout.width === 420 && layout.height > 0);
  for (const node of layout.nodes) assert.ok(node.width > 0 && node.height > 0 && Number.isFinite(node.x) && Number.isFinite(node.y));
  for (const edge of layout.edges) assert.ok(edge.points.length >= 2);
});

test('places sibling Flowchart branches on the same layer', () => {
  const layout = computeFlowchartLayout({
    width: 420,
    direction: 'vertical',
    nodes: [{ id: 'a', label: 'Solicitud' }, { id: 'si', label: 'Aprobar' }, { id: 'no', label: 'Rechazar' }],
    edges: [{ from: 'a', to: 'si', label: 'sí', style: 'solid' }, { from: 'a', to: 'no', label: 'no', style: 'solid' }]
  });
  const branch = layout.nodes.filter((node) => node.id !== 'a');
  assert.equal(branch.length, 2);
  assert.equal(Math.round(branch[0]!.y * 100) / 100, Math.round(branch[1]!.y * 100) / 100);
  assert.ok(branch[0]!.x < branch[1]!.x);
});

test('renders Flowchart cycles as loop edges without hanging', () => {
  const nodes = [{ id: 'a', label: 'A', kind: 'process' as const }, { id: 'b', label: 'B', kind: 'process' as const }];
  const edges = [{ from: 'a', to: 'b', style: 'solid' as const }, { from: 'b', to: 'a', style: 'solid' as const }];
  assert.equal(cyclicFlowchartEdges(nodes, edges).size, 1);
  const layout = computeFlowchartLayout({ width: 400, direction: 'vertical', nodes, edges });
  assert.ok(layout.nodes.every((node) => Number.isFinite(node.y)));
  assert.ok(layout.edges.some((edge) => edge.loop));
});

test('wraps and truncates long Flowchart labels', () => {
  const lines = wrapFlowchartText('un texto deliberadamente largo que no cabe en una sola linea del nodo', 18, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1]!.endsWith('…'));
  assert.ok(lines.every((line) => line.length <= 18));
});

test('keeps underscores in identifiers while parsing inline markup', () => {
  const runs = splitInlineMarkup('Estado EN_COLA y FINALIZADO_OK, con _énfasis_ y **negrita**.');
  assert.ok(runs.some((run) => run.text.includes('EN_COLA')));
  assert.ok(runs.some((run) => run.text.includes('FINALIZADO_OK')));
  assert.ok(runs.some((run) => run.kind === 'italic' && run.text === 'énfasis'));
  assert.ok(runs.some((run) => run.kind === 'bold' && run.text === 'negrita'));
});

test('splitPathList supports ; and : across platforms without breaking Windows drive letters', () => {
  assert.deepEqual(splitPathList('/var/pdfs:/tmp/reports'), ['/var/pdfs', '/tmp/reports']);
  assert.deepEqual(splitPathList('C:\\pdfs;D:\\reports'), ['C:\\pdfs', 'D:\\reports']);
  assert.deepEqual(splitPathList('C:/pdfs:D:/reports'), ['C:/pdfs', 'D:/reports']);
  assert.equal(expandHome('~/pdfs'), path.join(os.homedir(), 'pdfs'));
});

test('buildWorkspace prioritizes MCP roots and allows writing anywhere inside the workspace', () => {
  const projectDir = path.join(os.tmpdir(), 'workspace-test-project');
  const extraDir = path.join(os.tmpdir(), 'workspace-test-extra');
  const uri = pathToFileURL(projectDir).href;
  const fromUri = pathFromFileUri(uri);
  assert.ok(fromUri);
  const ws = buildWorkspace([fromUri!], { outputDirSetting: undefined, extraAllowedDirs: [extraDir], allowAnyPath: false });
  assert.equal(ws.source, 'mcp-roots');
  assert.ok(isPathAllowed(ws, path.join(ws.primaryRoot, 'reports', '2026', 'ventas.pdf')));
  assert.ok(isPathAllowed(ws, path.join(ws.outputDir, 'ventas.pdf')));
  assert.ok(isPathAllowed(ws, path.join(extraDir, 'externo.pdf')));
  assert.equal(displayPath(ws.primaryRoot, path.join(ws.primaryRoot, 'reports', 'ventas.pdf')), 'reports/ventas.pdf');
});

test('resolves Inter, headingFontFamily, JetBrainsMono and derived design palettes', async () => {
  await registerOptionalFonts();
  const parsed = generatePdfInputSchema.parse({
    filename: 'theme-check',
    theme: { preset: 'executive_dark', headingFontFamily: 'Times-Roman' },
    content: [{ type: 'Text', text: 'Texto en semibold', weight: 'semibold' }]
  });
  assert.equal(parsed.theme.fontFamily, 'Inter');
  const { theme, warnings } = resolveTheme(parsed.theme);
  assert.equal(warnings.length, 0);
  assert.equal(theme.font, 'Inter');
  assert.equal(theme.heading, 'Times-Roman');
  assert.equal(theme.mono, 'JetBrainsMono');
  assert.equal(theme.onPrimary, '#FFFFFF');
  assert.equal(readableText('#F8FAFC'), '#17212F');
  assert.match(withAlpha('#2F75B5', 0.12), /^rgba\(/);
  assert.match(mix('#173B67', '#FFFFFF', 0.5), /^#[0-9a-f]{6}$/i);
  assert.ok(metricValueSize('S/ 1,245,800.00 (consolidado)') < metricValueSize('S/ 120'));
});

test('flowchartPalette uses solid #RRGGBB hex backgrounds with high text contrast across presets and shorthand/bright accents', () => {
  const cases = [
    ['#263238', '#00796B', '#263238'],
    ['#1F2937', '#A78BFA', '#202938'],
    ['#09F', '#FDE047', '#CBD5E1']
  ] as const;
  for (const [primary, accent, text] of cases) {
    const palette = flowchartPalette(primary, accent, text);
    for (const [kind, colors] of Object.entries(palette)) {
      assert.match(colors.background, /^#[0-9a-f]{6}$/i, `${kind} background must be 6-digit hex (SVG fill breaks on rgba)`);
      assert.match(colors.border, /^#[0-9a-f]{6}$/i, `${kind} border must be 6-digit hex`);
      assert.match(colors.foreground, /^#[0-9a-f]{6}$/i, `${kind} foreground must be 6-digit hex`);
      assert.ok(luminance(colors.background) > 0.75, `${kind} background must be light enough for dark text`);
      assert.ok(luminance(colors.foreground) < 0.2, `${kind} foreground must be dark enough for contrast`);
    }
  }
});
