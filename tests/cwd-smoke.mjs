// Workspace-independence smoke test: starts the server from foreign folders and
// verifies that the server's own .env/assets are used while generated PDFs land
// in the calling workspace. Run after `npm run build`: node tests/cwd-smoke.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(process.env.TEMP ?? process.env.TMP ?? root, 'opencode', 'pdf-cwd-smoke');
const failures = [];
let checks = 0;

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

function cleanEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PDF_MCP_') && !(key in overrides)) delete env[key];
  }
  delete env.QPDF_PATH;
  delete env.DOTENV_CONFIG_PATH;
  for (const [key, value] of Object.entries(overrides)) env[key] = value;
  return env;
}

async function withServer(cwd, env, work) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'dist', 'index.js')],
    cwd,
    env,
    stderr: 'pipe'
  });
  const client = new Client({ name: 'mcp-pdf-cwd-smoke', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await work(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

const minimal = (filename) => ({
  filename,
  overwrite: true,
  metadata: { title: `Prueba ${filename}` },
  content: [
    { type: 'DocumentHeader', title: 'Prueba de workspace' },
    { type: 'Text', text: 'PDF generado desde un cwd distinto al de la instalación.' }
  ]
});

try {
  const workspaceA = path.join(base, 'proyecto-a');
  const workspaceB = path.join(base, 'proyecto-b');
  await fs.rm(base, { recursive: true, force: true });
  await fs.mkdir(workspaceA, { recursive: true });
  await fs.mkdir(workspaceB, { recursive: true });

  // A decoy .env in the workspace must be ignored: the server only reads its own .env.
  await fs.writeFile(
    path.join(workspaceA, '.env'),
    'PDF_MCP_OUTPUT_DIR=decoy-output\nQPDF_PATH=no-existe-qpdf\n',
    'utf8'
  );

  const first = await withServer(workspaceA, cleanEnv(), async (client) => {
    const generated = await client.callTool({ name: 'generate_pdf', arguments: minimal('desde-workspace-a') });
    const body = payload(generated);
    const secured = await client.callTool({
      name: 'apply_pdf_security',
      arguments: {
        filePath: body.filename,
        ownerPassword: 'propietario-2026',
        permissions: { printing: false, copying: false },
        outputFilename: 'desde-workspace-a-cifrado',
        overwrite: true
      }
    });
    return { body, secured: payload(secured) };
  });

  const expectedA = path.join(workspaceA, 'output', 'desde-workspace-a.pdf');
  check('los PDFs se escriben en <workspace>/output, no en el cwd de la instalación',
    first.body.success === true && path.resolve(first.body.path) === path.resolve(expectedA), { path: first.body.path, expectedA });
  check('el .env del workspace se ignora (no crea decoy-output)',
    !(await fs.access(path.join(workspaceA, 'decoy-output')).then(() => true, () => false)),
    path.join(workspaceA, 'decoy-output'));
  check('el .env del servidor se carga desde la instalación (QPDF_PATH funciona)',
    first.secured.encrypted === true && first.secured.algorithm === 'AES-256', first.secured);

  const second = await withServer(workspaceB, cleanEnv({
    PDF_MCP_OUTPUT_DIR: path.join(workspaceB, 'salida-custom')
  }), async (client) => {
    const generated = await client.callTool({ name: 'generate_pdf', arguments: minimal('desde-workspace-b') });
    return payload(generated);
  });

  const expectedB = path.join(workspaceB, 'salida-custom', 'desde-workspace-b.pdf');
  check('PDF_MCP_OUTPUT_DIR absoluto reemplaza la salida por defecto',
    second.success === true && path.resolve(second.path) === path.resolve(expectedB), { path: second.path, expectedB });
} finally {
  await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n${checks - failures.length}/${checks} comprobaciones correctas.`);
if (failures.length > 0) {
  console.error(`Fallaron ${failures.length} comprobaciones.`);
  process.exitCode = 1;
}
