// End-to-end smoke test: starts the built MCP server over stdio, exercises every
// tool with real payloads and verifies the generated artifacts with pdf-lib.
// Run after `npm run build`: node tests/e2e-smoke.mjs
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PDFDocument } from 'pdf-lib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'output');
const qpdfPath = process.env.QPDF_PATH || 'qpdf';
const failures = [];
let checks = 0;

function qpdfAvailable() {
  try {
    execFileSync(qpdfPath, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function qpdf(args) {
  return execFileSync(qpdfPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Extracts the text drawn on each page by decoding the hex strings of the
// content stream with qpdf. Used for layout regression checks.
function pdfPageTexts(filePath) {
  const pages = [];
  let current = null;
  for (const line of qpdf(['--show-pages', filePath]).split(/\r?\n/)) {
    const pageMatch = line.match(/^page (\d+):\s*\d+ 0 R/);
    if (pageMatch) {
      current = { page: Number(pageMatch[1]), contents: [] };
      pages.push(current);
      continue;
    }
    const contentMatch = line.match(/^\s+(\d+) 0 R\s*$/);
    if (current && contentMatch) current.contents.push(contentMatch[1]);
  }
  return pages.map(({ page, contents }) => {
    const stream = contents.map((ref) => qpdf([`--show-object=${ref}`, '--filtered-stream-data', filePath])).join('\n');
    const strings = stream.match(/<([0-9a-fA-F]+)>/g) ?? [];
    return { page, text: strings.map((token) => Buffer.from(token.slice(1, -1), 'hex').toString('latin1')).join('') };
  });
}

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push({ label, detail });
    console.log(`  FAIL ${label}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

function payload(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error(`Respuesta MCP sin texto: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: Boolean(result.isError), body: payload(result) };
}

async function inspectPdf(filePath) {
  const bytes = await fs.readFile(filePath);
  const pdf = await PDFDocument.load(bytes);
  return { bytes: bytes.length, pages: pdf.getPageCount(), title: pdf.getTitle() };
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist', 'index.js')],
  cwd: root,
  env: {
    ...process.env,
    PDF_MCP_TRANSPORT: 'stdio',
    PDF_MCP_OUTPUT_DIR: outputDir,
    PDF_MCP_ASSET_DIR: path.join(root, 'assets'),
    PDF_MCP_FONT_DIR: path.join(root, 'assets', 'fonts')
  },
  stderr: 'pipe'
});

const client = new Client({ name: 'mcp-pdf-e2e', version: '1.0.0' });
let serverErrors = '';
transport.stderr?.on('data', (chunk) => { serverErrors += chunk.toString(); });

try {
  await client.connect(transport);
  console.log('Conectado al servidor MCP por stdio.');

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  check('expone las 5 herramientas esperadas', names.length === 5 && names.includes('generate_pdf'), names);

  const catalog = await call(client, 'list_pdf_components', { category: 'all' });
  check('list_pdf_components responde el catálogo', !catalog.isError && catalog.body.componentCount >= 19, catalog.body.componentCount);

  const example = JSON.parse(await fs.readFile(path.join(root, 'examples', 'monthly-sales-report.json'), 'utf8'));

  const validation = await call(client, 'validate_pdf_ast', example);
  check('validate_pdf_ast acepta el ejemplo', !validation.isError && validation.body.valid === true, validation.body.errors);

  const generated = await call(client, 'generate_pdf', { ...example, filename: 'e2e-informe-ventas', overwrite: true });
  check('generate_pdf genera el informe de ejemplo', !generated.isError && generated.body.success === true, generated.body);
  const report = await inspectPdf(generated.body.path);
  check('el informe es un PDF con páginas', report.pages > 0 && report.bytes > 1000, report);
  check('los metadatos del PDF se aplicaron', report.title === example.metadata.title, report.title);

  const annexDoc = {
    filename: 'e2e-anexo',
    theme: { preset: 'modern_minimal' },
    metadata: { title: 'Anexo de prueba', author: 'E2E' },
    content: [
      { type: 'DocumentHeader', title: 'Anexo' },
      { type: 'Text', text: 'Documento auxiliar para probar **merge_pdfs**.' },
      { type: 'Flowchart', title: 'Flujo de prueba', nodes: [{ id: 'inicio', label: 'Solicitud recibida', kind: 'start' }, { id: 'valida', label: 'Datos completos', kind: 'decision' }, { id: 'ok', label: 'Documento emitido', kind: 'end' }], edges: [{ from: 'inicio', to: 'valida' }, { from: 'valida', to: 'ok', label: 'sí' }], caption: 'Diagrama de flujo de prueba.' },
      { type: 'QRCode', value: 'https://example.com/anexo', caption: 'QR de prueba' }
    ],
    overwrite: true
  };
  const annex = await call(client, 'generate_pdf', annexDoc);
  check('generate_pdf acepta un AST mínimo con QR', !annex.isError && annex.body.success === true, annex.body);

  const merged = await call(client, 'merge_pdfs', {
    filePaths: [generated.body.filename, annex.body.filename],
    outputFilename: 'e2e-merged',
    overwrite: true
  });
  check('merge_pdfs combina ambos documentos', !merged.isError && merged.body.success === true, merged.body);
  const mergedPdf = await inspectPdf(merged.body.path);
  check('el PDF combinado suma las páginas', mergedPdf.pages === generated.body.pages + annex.body.pages, mergedPdf);

  const secured = await call(client, 'apply_pdf_security', {
    filePath: merged.body.filename,
    metadata: { title: 'Documento combinado (metadatos actualizados)', author: 'E2E' },
    outputFilename: 'e2e-merged-metadata',
    overwrite: true
  });
  check('apply_pdf_security actualiza metadatos sin qpdf', !secured.isError && secured.body.success === true && secured.body.encrypted === false, secured.body);
  const securedPdf = await inspectPdf(secured.body.path);
  check('los metadatos actualizados persisten', securedPdf.title === 'Documento combinado (metadatos actualizados)', securedPdf.title);

  if (qpdfAvailable()) {
    const pages = pdfPageTexts(generated.body.path);
    const page1 = pages.find((item) => item.page === 1)?.text ?? '';
    const page2 = pages.find((item) => item.page === 2)?.text ?? '';
    check('la página 1 no deja cabecera de tabla huérfana', !page1.includes('Participación') && !page1.includes('Desempeño por canal'), page1.slice(-240));
    check('la sección 3 arranca en la página 2 con cabecera y filas', page2.includes('Desempeño por canal') && page2.includes('Participación') && page2.includes('Tiendas'), page2.slice(0, 320));
    const annexText = pdfPageTexts(annex.body.path).map((item) => item.text).join('');
    check('el Flowchart dibuja las etiquetas de sus nodos', annexText.includes('Solicitud recibida') && annexText.includes('Documento emitido'), annexText.slice(-240));
  } else {
    console.log('  skip qpdf no disponible: se omite la comprobación de saltos de página');
  }

  const restricted = await call(client, 'apply_pdf_security', {
    filePath: merged.body.filename,
    permissions: { printing: false, copying: true },
    outputFilename: 'e2e-merged-restricted-sin-owner',
    overwrite: true
  });
  check('rechaza restricciones de permisos sin ownerPassword', restricted.isError && JSON.stringify(restricted.body).includes('ownerPassword'), restricted.body);

  if (!qpdfAvailable()) {
    console.log('  skip qpdf no disponible: se omite la prueba de cifrado AES-256');
  } else {
    const encrypted = await call(client, 'apply_pdf_security', {
      filePath: merged.body.filename,
      userPassword: 'lector-2026',
      ownerPassword: 'propietario-2026',
      permissions: { printing: false, copying: false },
      outputFilename: 'e2e-merged-cifrado',
      overwrite: true
    });
    check('apply_pdf_security cifra con AES-256', !encrypted.isError && encrypted.body.success === true && encrypted.body.encrypted === true && encrypted.body.algorithm === 'AES-256', encrypted.body);

    const encryptionInfo = qpdf(['--show-encryption', '--password=propietario-2026', encrypted.body.path]);
    check('qpdf confirma cifrado R=6 (AES-256)', /R = 6/.test(encryptionInfo), encryptionInfo);
    check('qpdf confirma extracción bloqueada', /extract for any purpose:\s*not allowed/i.test(encryptionInfo), encryptionInfo);
    check('qpdf confirma impresión bloqueada', /print:\s*not allowed|print low resolution:\s*not allowed/i.test(encryptionInfo), encryptionInfo);

    let passwordRequired = false;
    try {
      qpdf(['--requires-password', encrypted.body.path]);
      passwordRequired = true;
    } catch {
      passwordRequired = false;
    }
    check('el PDF cifrado exige contraseña para abrirse', passwordRequired);
  }

  const traversal = await call(client, 'generate_pdf', { ...example, filename: 'e2e-escape', outputDir: '..', overwrite: true });
  check('el sandbox rechaza outputDir fuera de PDF_MCP_OUTPUT_DIR', traversal.isError && JSON.stringify(traversal.body).includes('PATH_OUTSIDE_SANDBOX'), traversal.body);

  const invalid = await call(client, 'validate_pdf_ast', { filename: 'x', content: [{ type: 'Text', text: 'hola', onClick: 'alert(1)' }] });
  check('validate_pdf_ast reporta propiedades no permitidas', !invalid.isError && invalid.body.valid === false, invalid.body.errors);
} finally {
  await client.close().catch(() => undefined);
}

if (serverErrors.trim()) {
  console.log('\nstderr del servidor:');
  console.log(serverErrors.trim());
}

console.log(`\n${checks - failures.length}/${checks} comprobaciones correctas.`);
if (failures.length > 0) {
  console.error(`Fallaron ${failures.length} comprobaciones.`);
  process.exitCode = 1;
} else {
  console.log(`PDFs en: ${outputDir}`);
}
