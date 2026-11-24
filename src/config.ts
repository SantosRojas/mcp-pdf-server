import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { canonicalPathSync, resolveUserPath, splitPathList } from './utils/paths.js';

/**
 * Installation directory of the server (the folder that contains package.json/dist).
 * Immutable resources such as .env, assets and fonts are resolved from here, so the
 * server behaves identically no matter which project folder starts the process.
 */
export const serverRoot = canonicalPathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

/**
 * Folder the client process was started from. It is only a fallback: when the MCP client
 * declares workspace roots, those are preferred so PDFs land in the project in use.
 */
export const workspaceRoot = canonicalPathSync(process.cwd());

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: string };

// Load the server's own .env, never the client project's (which may hold unrelated secrets).
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? path.join(serverRoot, '.env'), quiet: true });

interface CliOverrides {
  transport?: string;
  host?: string;
  port?: string;
  outputDir?: string;
  allowedDirs: string[];
  allowAnyPath?: boolean;
}

/**
 * Cross-platform CLI flag parser so scripts and MCP configs work identically on Windows,
 * macOS and Linux without POSIX-only `VAR=value command` wrappers.
 */
function parseCliArgs(argv: string[]): CliOverrides {
  const overrides: CliOverrides = { allowedDirs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--http') overrides.transport = 'http';
    else if (arg === '--stdio') overrides.transport = 'stdio';
    else if (arg === '--allow-any-path') overrides.allowAnyPath = true;
    else if (arg.startsWith('--transport=')) overrides.transport = arg.slice('--transport='.length);
    else if (arg === '--transport' && argv[i + 1]) overrides.transport = argv[++i]!;
    else if (arg.startsWith('--host=')) overrides.host = arg.slice('--host='.length);
    else if (arg === '--host' && argv[i + 1]) overrides.host = argv[++i]!;
    else if (arg.startsWith('--port=')) overrides.port = arg.slice('--port='.length);
    else if (arg === '--port' && argv[i + 1]) overrides.port = argv[++i]!;
    else if (arg.startsWith('--output-dir=')) overrides.outputDir = arg.slice('--output-dir='.length);
    else if (arg === '--output-dir' && argv[i + 1]) overrides.outputDir = argv[++i]!;
    else if (arg.startsWith('--allow-dir=')) overrides.allowedDirs.push(...splitPathList(arg.slice('--allow-dir='.length)));
    else if (arg === '--allow-dir' && argv[i + 1]) overrides.allowedDirs.push(...splitPathList(argv[++i]!));
  }
  return overrides;
}

const cli = parseCliArgs(process.argv.slice(2));

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

const outputDirSetting = (cli.outputDir ?? process.env.PDF_MCP_OUTPUT_DIR)?.trim() || undefined;
const extraAllowedRaw = [...splitPathList(process.env.PDF_MCP_ALLOWED_DIRS), ...cli.allowedDirs];

export const config = {
  version: packageJson.version ?? '0.0.0',
  transport: cli.transport ?? process.env.PDF_MCP_TRANSPORT ?? 'stdio',
  host: cli.host ?? process.env.PDF_MCP_HOST ?? '127.0.0.1',
  port: integer(cli.port ?? process.env.PDF_MCP_PORT, 3333, 1, 65535),
  httpPath: process.env.PDF_MCP_HTTP_PATH ?? '/mcp',
  authToken: process.env.PDF_MCP_AUTH_TOKEN ?? '',
  allowedOrigins: (process.env.PDF_MCP_ALLOWED_ORIGINS ?? 'http://localhost:3000')
    .split(',').map((x) => x.trim()).filter(Boolean),
  // Output defaults to <workspace>/output. A relative override is resolved against the
  // workspace root; an absolute override pins a single folder for every project.
  outputDirSetting,
  // Extra folders an agent may write to, on top of the workspace roots and the output dir.
  extraAllowedDirs: extraAllowedRaw.map((item) => resolveUserPath(workspaceRoot, item)),
  // Escape hatch for controlled environments: allow any absolute path. Off by default.
  allowAnyPath: cli.allowAnyPath ?? bool(process.env.PDF_MCP_ALLOW_ANY_PATH, false),
  assetDir: resolveUserPath(serverRoot, process.env.PDF_MCP_ASSET_DIR ?? './assets'),
  fontDir: resolveUserPath(serverRoot, process.env.PDF_MCP_FONT_DIR ?? './assets/fonts'),
  maxOutputBytes: integer(process.env.PDF_MCP_MAX_OUTPUT_BYTES, 50 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
  maxInputBytes: integer(process.env.PDF_MCP_MAX_INPUT_BYTES, 50 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
  allowRemoteImages: bool(process.env.PDF_MCP_ALLOW_REMOTE_IMAGES, false),
  imageTimeoutMs: integer(process.env.PDF_MCP_IMAGE_TIMEOUT_MS, 5000, 250, 30000),
  imageMaxBytes: integer(process.env.PDF_MCP_IMAGE_MAX_BYTES, 8 * 1024 * 1024, 1024, 50 * 1024 * 1024),
  maxConcurrentRenders: integer(process.env.PDF_MCP_MAX_CONCURRENT_RENDERS, 2, 1, 16),
  qpdfPath: process.env.QPDF_PATH ?? 'qpdf',
  qpdfTimeoutMs: integer(process.env.PDF_MCP_QPDF_TIMEOUT_MS, 30_000, 1_000, 300_000),
  sessionTtlMs: integer(process.env.PDF_MCP_SESSION_TTL_MS, 30 * 60 * 1_000, 5_000, 24 * 60 * 60 * 1_000)
} as const;
