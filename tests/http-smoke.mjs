// HTTP transport smoke test: starts the built server with Streamable HTTP,
// verifies auth/health endpoints and drives the MCP client over the network.
// Run after `npm run build`: node tests/http-smoke.mjs
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'output');
const port = 34567;
const baseUrl = `http://127.0.0.1:${port}`;
const token = `smoke-${randomUUID()}`;
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

const child = spawn(process.execPath, [path.join(root, 'dist', 'index.js'), '--transport=http'], {
  cwd: root,
  env: {
    ...process.env,
    PDF_MCP_TRANSPORT: 'http',
    PDF_MCP_HOST: '127.0.0.1',
    PDF_MCP_PORT: String(port),
    PDF_MCP_AUTH_TOKEN: token,
    PDF_MCP_ALLOWED_HOSTS: 'localhost,127.0.0.1,::1',
    PDF_MCP_ALLOWED_ORIGINS: 'http://localhost:3000',
    PDF_MCP_OUTPUT_DIR: outputDir,
    PDF_MCP_ASSET_DIR: path.join(root, 'assets'),
    PDF_MCP_FONT_DIR: path.join(root, 'assets', 'fonts')
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverLog = '';
child.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
child.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

async function waitForHealth(timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return response;
    } catch { /* server not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`El servidor HTTP no respondió en ${timeoutMs} ms.\n${serverLog}`);
}

let client;
try {
  const health = await waitForHealth();
  const healthBody = await health.json();
  check('GET /healthz responde 200 sin token', health.status === 200 && healthBody.status === 'ok', healthBody);

  const unauthorized = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  check('POST /mcp sin bearer token responde 401', unauthorized.status === 401, unauthorized.status);

  const wrongToken = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token-invalido' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  check('POST /mcp con token inválido responde 401', wrongToken.status === 401, wrongToken.status);

  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  client = new Client({ name: 'mcp-pdf-http-smoke', version: '1.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  check('el cliente HTTP lista las 8 herramientas', tools.tools.length === 8 && tools.tools.some((t) => t.name === 'inspect_pdf'), tools.tools.map((tool) => tool.name));

  const generated = await client.callTool({
    name: 'generate_pdf',
    arguments: {
      filename: 'e2e-http-demo',
      overwrite: true,
      metadata: { title: 'Demo HTTP MCP' },
      content: [
        { type: 'DocumentHeader', title: 'Transporte HTTP' },
        { type: 'Text', text: 'PDF generado a través de **Streamable HTTP** con bearer token.' }
      ]
    }
  });
  const body = payload(generated);
  check('generate_pdf funciona por Streamable HTTP', !generated.isError && body.success === true && body.pages === 1, body);
} finally {
  await client?.close().catch(() => undefined);
  child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 3_000);
  });
}

console.log(`\n${checks - failures.length}/${checks} comprobaciones correctas.`);
if (failures.length > 0) {
  console.error(`Fallaron ${failures.length} comprobaciones.`);
  process.exitCode = 1;
}
