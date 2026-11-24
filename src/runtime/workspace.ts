import path from 'node:path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config, serverRoot, workspaceRoot } from '../config.js';
import { isWithin, pathFromFileUri, resolveUserPath, uniquePaths } from '../utils/paths.js';

export interface WorkspaceInfo {
  /** Absolute folders the client declared as workspace roots (or the process cwd). */
  roots: string[];
  /** Where `roots` came from, so the agent can explain the chosen folder. */
  source: 'mcp-roots' | 'cwd';
  /** First workspace root: the base for relative paths and the default output folder. */
  primaryRoot: string;
  /** Folder used when `generate_pdf` receives no `outputDir`. */
  outputDir: string;
  /** Folders where new files may be written. */
  allowedRoots: string[];
  /** Folders searched (in order) when a tool receives a relative input path. */
  searchRoots: string[];
  /** True only when PDF_MCP_ALLOW_ANY_PATH was explicitly enabled. */
  allowAnyPath: boolean;
}

const cache = new WeakMap<McpServer, Promise<WorkspaceInfo>>();

export function invalidateWorkspace(server: McpServer): void {
  cache.delete(server);
}

/** Resolves (and caches) the workspace once per MCP server instance. */
export function getWorkspace(server: McpServer): Promise<WorkspaceInfo> {
  let pending = cache.get(server);
  if (!pending) {
    pending = resolveWorkspace(server.server);
    cache.set(server, pending);
  }
  return pending;
}

export function isPathAllowed(workspace: WorkspaceInfo, candidate: string): boolean {
  if (workspace.allowAnyPath) return true;
  return workspace.allowedRoots.some((root) => isWithin(root, candidate));
}

function fallbackRoot(): string {
  // Never use C:\ or / as the project root when the client opens at a filesystem root.
  if (path.parse(workspaceRoot).root === workspaceRoot) return path.join(serverRoot, 'output');
  return workspaceRoot;
}

/**
 * Pure builder used by both the MCP roots resolver and direct programmatic callers.
 * When `declaredRoots` is empty, it falls back to the process working directory.
 */
export function buildWorkspace(
  declaredRoots: string[] = [],
  options?: { outputDirSetting?: string | undefined; extraAllowedDirs?: string[]; allowAnyPath?: boolean }
): WorkspaceInfo {
  const cleanDeclared = uniquePaths(declaredRoots);
  const roots = cleanDeclared.length > 0 ? cleanDeclared : [fallbackRoot()];
  const primaryRoot = roots[0]!;
  const outputSetting = options && 'outputDirSetting' in options ? options.outputDirSetting : config.outputDirSetting;
  const extraDirs = options?.extraAllowedDirs ?? config.extraAllowedDirs;
  const allowAnyPath = options?.allowAnyPath ?? config.allowAnyPath;
  const outputDir = outputSetting
    ? resolveUserPath(primaryRoot, outputSetting)
    : path.join(primaryRoot, 'output');
  const allowedRoots = uniquePaths([outputDir, ...roots, ...extraDirs]);
  // Relative inputs are looked up in the project first, then in the output folder and
  // any explicitly allowed directory. This makes `merge_pdfs(["informe.pdf"])` work
  // whether the file sits in the project root or in <project>/output.
  const searchRoots = uniquePaths([primaryRoot, outputDir, ...roots, ...extraDirs]);
  return {
    roots,
    source: cleanDeclared.length > 0 ? 'mcp-roots' : 'cwd',
    primaryRoot,
    outputDir,
    allowedRoots,
    searchRoots,
    allowAnyPath
  };
}

/** Synchronous workspace used when a tool function is called directly in tests or scripts. */
export function defaultWorkspace(): WorkspaceInfo {
  return buildWorkspace();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout después de ${ms} ms`)), ms);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * The MCP `roots` capability is how a client tells the server which project is in use.
 * It is the reliable alternative to `process.cwd()`, which depends on how the client
 * spawns the server (a global MCP config may not start in the project folder at all).
 */
async function clientRoots(server: Server): Promise<string[]> {
  try {
    if (!server.getClientCapabilities()?.roots) return [];
    const result = await withTimeout(server.listRoots(), 3_000);
    return uniquePaths(
      result.roots
        .map((root) => pathFromFileUri(root.uri))
        .filter((value): value is string => typeof value === 'string')
    );
  } catch {
    return [];
  }
}

async function resolveWorkspace(server: Server): Promise<WorkspaceInfo> {
  return buildWorkspace(await clientRoots(server));
}
