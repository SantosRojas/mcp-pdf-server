import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { createPdfMcpServer } from '../server.js';

interface SessionRecord { server: McpServer; transport: StreamableHTTPServerTransport; }

export interface SessionRegistryOptions<T> {
  maxSessions: number;
  ttlMs: number;
  onClose?: (id: string, value: T) => Promise<void> | void;
}

export class SessionRegistry<T> {
  private readonly entries = new Map<string, { value: T; lastActiveAt: number }>();
  private pending = 0;

  constructor(private readonly options: SessionRegistryOptions<T>) {}

  get size(): number {
    return this.entries.size;
  }

  evictExpired(now = Date.now()): number {
    let evicted = 0;
    for (const [id, entry] of this.entries) {
      if (now - entry.lastActiveAt >= this.options.ttlMs) {
        this.entries.delete(id);
        evicted += 1;
        void Promise.resolve(this.options.onClose?.(id, entry.value)).catch(() => undefined);
      }
    }
    return evicted;
  }

  canAccept(now = Date.now()): boolean {
    this.evictExpired(now);
    return this.entries.size + this.pending < this.options.maxSessions;
  }

  tryReserveSlot(now = Date.now()): boolean {
    if (!this.canAccept(now)) return false;
    this.pending += 1;
    return true;
  }

  releaseSlot(): void {
    if (this.pending > 0) this.pending -= 1;
  }

  get(id: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (now - entry.lastActiveAt >= this.options.ttlMs) {
      this.entries.delete(id);
      void Promise.resolve(this.options.onClose?.(id, entry.value)).catch(() => undefined);
      return undefined;
    }
    entry.lastActiveAt = now;
    return entry.value;
  }

  set(id: string, value: T, now = Date.now()): void {
    this.entries.set(id, { value, lastActiveAt: now });
  }

  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  values(): IterableIterator<T> {
    return Array.from(this.entries.values(), (entry) => entry.value).values();
  }
}

const MAX_SESSIONS = 100;
const sessions = new SessionRegistry<SessionRecord>({
  maxSessions: MAX_SESSIONS,
  ttlMs: config.sessionTtlMs,
  onClose: async (_id, record) => {
    await record.transport.close().catch(() => undefined);
    await record.server.close().catch(() => undefined);
  }
});
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function hostAllowed(req: IncomingMessage): boolean {
  const raw = req.headers.host ?? '';
  const hostname = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0] ?? '';
  const allowed = (process.env.PDF_MCP_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,::1').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(hostname.toLowerCase());
}

function authorized(req: IncomingMessage): boolean {
  const token = config.authToken;
  const remoteAddress = req.socket.remoteAddress ?? '';
  const localPeer = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
  if (!token) return localPeer;
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const left = Buffer.from(provided);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return config.allowedOrigins.includes(origin);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) throw new Error('Content-Type debe ser application/json.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('La solicitud supera el límite de 16 MiB.');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('El cuerpo de la solicitud no contiene JSON válido.'); }
}

function sessionId(req: IncomingMessage): string | undefined {
  const value = req.headers['mcp-session-id'];
  return Array.isArray(value) ? value[0] : value;
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let body: unknown;
  if (method === 'POST') {
    try { body = await readJsonBody(req); }
    catch (error) { json(res, 400, { error: error instanceof Error ? error.message : String(error) }); return; }
  }

  const suppliedId = sessionId(req);
  let record = suppliedId ? sessions.get(suppliedId) : undefined;

  let reservedSlot = false;
  if (method === 'POST' && !suppliedId) {
    if (!sessions.tryReserveSlot()) { json(res, 503, { error: 'Se alcanzó el máximo de sesiones MCP.' }); return; }
    reservedSlot = true;
    const mcpServer = createPdfMcpServer();
    let initializedId: string | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        initializedId = id;
        if (reservedSlot) {
          sessions.releaseSlot();
          reservedSlot = false;
        }
        sessions.set(id, { server: mcpServer, transport });
      },
      onsessionclosed: (id) => { sessions.delete(id); }
    });
    transport.onerror = (error) => console.error('[mcp-pdf:http]', error);
    transport.onclose = () => {
      if (initializedId) sessions.delete(initializedId);
      void mcpServer.close().catch(() => undefined);
    };
    record = { server: mcpServer, transport };
    await mcpServer.connect(transport);
  } else if (!record) {
    json(res, 404, { error: 'Sesión MCP no encontrada o expirada.' });
    return;
  }

  try {
    await record.transport.handleRequest(req, res, body);
  } catch (error) {
    console.error('[mcp-pdf:http]', error);
    if (!res.headersSent) json(res, 500, { error: 'Error interno procesando MCP.' });
    else res.end();
  } finally {
    if (reservedSlot) sessions.releaseSlot();
  }
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (!hostAllowed(req)) { json(res, 403, { error: 'Host no permitido.' }); return; }
    if (!originAllowed(req)) { json(res, 403, { error: 'Origin no permitido.' }); return; }
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-headers', 'authorization,content-type,mcp-session-id,mcp-protocol-version');
      res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('vary', 'Origin');
    }
    // CORS preflight requests do not carry bearer credentials.
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    // Local container health probes should not need the application bearer token.
    if (requestUrl.pathname === '/healthz' && req.method === 'GET') {
      sessions.evictExpired();
      json(res, 200, { status: 'ok', service: 'mcp-pdf-server', sessions: sessions.size });
      return;
    }
    if (!authorized(req)) { json(res, 401, { error: 'Autenticación requerida.' }); return; }
    if (requestUrl.pathname !== config.httpPath) { json(res, 404, { error: 'Not found.' }); return; }
    if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) { json(res, 405, { error: 'Method not allowed.' }); return; }
    await handleMcp(req, res);
  } catch (error) {
    console.error('[mcp-pdf:http]', error);
    if (!res.headersSent) json(res, 500, { error: 'Error interno procesando la solicitud HTTP.' });
    else if (!res.writableEnded) res.end();
  }
}

export async function startHttpTransport(): Promise<void> {
  if (!config.authToken && !isLoopback(config.host)) {
    throw new Error('Para escuchar fuera de loopback configura PDF_MCP_AUTH_TOKEN con un token aleatorio largo.');
  }
  const httpServer = createHttpServer((req, res) => { void handleHttpRequest(req, res); });
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 35_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.listen(config.port, config.host, () => {
    console.error(`mcp-pdf-server HTTP listo en http://${config.host}:${config.port}${config.httpPath}`);
  });
  const sweepTimer = setInterval(() => { sessions.evictExpired(); }, 60_000);
  sweepTimer.unref();
  const shutdown = () => {
    clearInterval(sweepTimer);
    for (const session of sessions.values()) void session.transport.close().catch(() => undefined);
    httpServer.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
