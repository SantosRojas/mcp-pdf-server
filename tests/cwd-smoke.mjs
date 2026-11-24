// Workspace-independence smoke test: starts the server from foreign folders and
// verifies that the server's own .env/assets are used while generated PDFs land
// in the calling workspace (via cwd or MCP roots) or any allowed folder.
// Run after `npm run build`: node tests/cwd-smoke.mjs
import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(os.tmpdir(), 'opencode', `pdf-cwd-smoke-${process.pid}`);
const failures = [];
let checks = 0;

function samePath(left, right) {
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
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

async function withServer(cwd, env, work, roots = undefined) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'dist', 'index.js')],
    cwd,
    env,
    stderr: 'pipe'
  });
  const client = roots
    ? new Client({ name: 'mcp-pdf-cwd-smoke', version: '1.0.0' }, { capabilities: { roots: { listChanged: true } } })
    : new Client({ name: 'mcp-pdf-cwd-smoke', version: '1.0.0' });
  if (roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: roots.map((dir) => ({ uri: pathToFileURL(dir).href, name: path.basename(dir) }))
    }));
  }
  await client.connect(transport);
  try {
    return await work(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

const minimal = (filename, extra = {}) => ({
  filename,
  overwrite: true,
  metadata: { title: `Prueba ${filename}` },
  content: [
    { type: 'DocumentHeader', title: 'Prueba de workspace' },
    { type: 'Text', text: 'PDF generado desde un proyecto externo con `código inline`.' }
  ],
  ...extra
});

try {
  const workspaceA = path.join(base, 'proyecto-a');
  const workspaceB = path.join(base, 'proyecto-b');
  const workspaceC = path.join(base, 'proyecto-roots');
  const sharedExternal = path.join(base, 'compartido-externo');
  await fs.rm(base, { recursive: true, force: true });
  await fs.mkdir(workspaceA, { recursive: true });
  await fs.mkdir(workspaceB, { recursive: true });
  await fs.mkdir(workspaceC, { recursive: true });
  await fs.mkdir(sharedExternal, { recursive: true });

  // A decoy .env in the workspace must be ignored: the server only reads its own .env.
  await fs.writeFile(
    path.join(workspaceA, '.env'),
    'PDF_MCP_OUTPUT_DIR=decoy-output\nQPDF_PATH=no-existe-qpdf\n',
    'utf8'
  );

  const first = await withServer(workspaceA, cleanEnv({ PDF_MCP_ALLOWED_DIRS: sharedExternal }), async (client) => {
    const info = payload(await client.callTool({ name: 'get_pdf_server_info', arguments: {} }));
    const generated = payload(await client.callTool({ name: 'generate_pdf', arguments: minimal('desde-workspace-a') }));
    const inSubdir = payload(await client.callTool({
      name: 'generate_pdf',
      arguments: minimal('en-subcarpeta', { outputDir: 'docs/reportes' })
    }));
    const inRoot = payload(await client.callTool({
      name: 'generate_pdf',
      arguments: minimal('en-raiz', { outputDir: '.' })
    }));
    const inExternal = payload(await client.callTool({
      name: 'generate_pdf',
      arguments: minimal('en-externo', { outputDir: sharedExternal })
    }));
    const listed = payload(await client.callTool({
      name: 'list_pdfs',
      arguments: { recursive: true, limit: 50 }
    }));
    let secured = null;
    if (info.capabilities?.qpdf?.available) {
      secured = payload(await client.callTool({
        name: 'apply_pdf_security',
        arguments: {
          filePath: generated.filename,
          ownerPassword: 'propietario-2026',
          permissions: { printing: false, copying: false },
          outputFilename: 'desde-workspace-a-cifrado',
          overwrite: true
        }
      }));
    }
    return { info, generated, inSubdir, inRoot, inExternal, listed, secured };
  });

  const expectedA = path.join(workspaceA, 'output', 'desde-workspace-a.pdf');
  check('los PDFs sin outputDir se escriben en <workspace>/output',
    first.generated.success === true && samePath(first.generated.path, expectedA),
    { path: first.generated.path, expectedA });
  check('outputDir relativo guarda en cualquier subcarpeta del proyecto (docs/reportes)',
    first.inSubdir.success === true && samePath(first.inSubdir.path, path.join(workspaceA, 'docs', 'reportes', 'en-subcarpeta.pdf')) && first.inSubdir.relativePath === 'docs/reportes/en-subcarpeta.pdf',
    first.inSubdir);
  check('outputDir="." guarda directamente en la raíz del proyecto',
    first.inRoot.success === true && samePath(first.inRoot.path, path.join(workspaceA, 'en-raiz.pdf')) && first.inRoot.relativePath === 'en-raiz.pdf',
    first.inRoot);
  check('PDF_MCP_ALLOWED_DIRS habilita rutas absolutas fuera del proyecto',
    first.inExternal.success === true && samePath(first.inExternal.path, path.join(sharedExternal, 'en-externo.pdf')),
    first.inExternal);
  check('list_pdfs encuentra PDFs en la raíz, subcarpetas, output y carpetas permitidas',
    first.listed.success === true && first.listed.count >= 4,
    first.listed);
  check('el .env del workspace se ignora (no crea decoy-output)',
    !(await fs.access(path.join(workspaceA, 'decoy-output')).then(() => true, () => false)),
    path.join(workspaceA, 'decoy-output'));
  if (first.info.capabilities?.qpdf?.available) {
    check('qpdf funciona desde un workspace externo',
      first.secured?.encrypted === true && first.secured?.algorithm === 'AES-256', first.secured);
  }

  const second = await withServer(workspaceB, cleanEnv({
    PDF_MCP_OUTPUT_DIR: path.join(workspaceB, 'salida-custom')
  }), async (client) => {
    const generated = await client.callTool({ name: 'generate_pdf', arguments: minimal('desde-workspace-b') });
    return payload(generated);
  });

  const expectedB = path.join(workspaceB, 'salida-custom', 'desde-workspace-b.pdf');
  check('PDF_MCP_OUTPUT_DIR absoluto reemplaza la salida por defecto',
    second.success === true && samePath(second.path, expectedB), { path: second.path, expectedB });

  // Spawn from `root` (installation folder) while the client declares `workspaceC` via MCP roots.
  const third = await withServer(root, cleanEnv(), async (client) => {
    const info = payload(await client.callTool({ name: 'get_pdf_server_info', arguments: {} }));
    const generated = payload(await client.callTool({ name: 'generate_pdf', arguments: minimal('desde-mcp-roots') }));
    return { info, generated };
  }, [workspaceC]);

  const expectedC = path.join(workspaceC, 'output', 'desde-mcp-roots.pdf');
  check('cuando el cliente declara MCP roots, los PDFs se guardan en ese proyecto aunque el cwd sea otro',
    third.info.workspace?.source === 'mcp-roots' && third.generated.success === true && samePath(third.generated.path, expectedC),
    { info: third.info.workspace, path: third.generated.path, expectedC });
} finally {
  await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n${checks - failures.length}/${checks} comprobaciones correctas.`);
if (failures.length > 0) {
  console.error(`Fallaron ${failures.length} comprobaciones.`);
  process.exitCode = 1;
}
