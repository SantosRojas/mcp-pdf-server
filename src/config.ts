import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * Installation directory of the server (the folder that contains package.json/dist).
 * Immutable resources such as .env, assets and fonts are resolved from here, so the
 * server behaves identically no matter which project folder starts the process.
 */
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Client workspace (the folder OpenCode starts the MCP server from). Generated PDFs
 * default to <workspace>/output, which keeps artifacts next to the project that asked
 * for them. Set PDF_MCP_OUTPUT_DIR to an absolute path to override it.
 */
const workspaceRoot = process.cwd();

// Load the server's own .env, never the client project's (which may hold unrelated secrets).
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? path.join(serverRoot, '.env'), quiet: true });

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function defaultOutputDir(): string {
  // Never create C:\output or /output when the client opens at a filesystem root.
  if (path.parse(workspaceRoot).root === workspaceRoot) return path.join(serverRoot, 'output');
  return path.join(workspaceRoot, 'output');
}

export const config = {
  transport: process.env.PDF_MCP_TRANSPORT ?? 'stdio',
  host: process.env.PDF_MCP_HOST ?? '127.0.0.1',
  port: integer(process.env.PDF_MCP_PORT, 3333, 1, 65535),
  httpPath: process.env.PDF_MCP_HTTP_PATH ?? '/mcp',
  authToken: process.env.PDF_MCP_AUTH_TOKEN ?? '',
  allowedOrigins: (process.env.PDF_MCP_ALLOWED_ORIGINS ?? 'http://localhost:3000')
    .split(',').map((x) => x.trim()).filter(Boolean),
  // Generated files follow the client workspace; read-only resources follow the installation.
  outputDir: process.env.PDF_MCP_OUTPUT_DIR
    ? path.resolve(workspaceRoot, process.env.PDF_MCP_OUTPUT_DIR)
    : defaultOutputDir(),
  assetDir: path.resolve(serverRoot, process.env.PDF_MCP_ASSET_DIR ?? './assets'),
  fontDir: path.resolve(serverRoot, process.env.PDF_MCP_FONT_DIR ?? './assets/fonts'),
  maxOutputBytes: integer(process.env.PDF_MCP_MAX_OUTPUT_BYTES, 50 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
  maxInputBytes: integer(process.env.PDF_MCP_MAX_INPUT_BYTES, 50 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
  allowRemoteImages: bool(process.env.PDF_MCP_ALLOW_REMOTE_IMAGES, false),
  imageTimeoutMs: integer(process.env.PDF_MCP_IMAGE_TIMEOUT_MS, 5000, 250, 30000),
  imageMaxBytes: integer(process.env.PDF_MCP_IMAGE_MAX_BYTES, 8 * 1024 * 1024, 1024, 50 * 1024 * 1024),
  maxConcurrentRenders: integer(process.env.PDF_MCP_MAX_CONCURRENT_RENDERS, 2, 1, 16),
  qpdfPath: process.env.QPDF_PATH ?? 'qpdf',
  qpdfTimeoutMs: integer(process.env.PDF_MCP_QPDF_TIMEOUT_MS, 30_000, 1_000, 300_000)
} as const;
