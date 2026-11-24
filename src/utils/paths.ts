import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Windows and macOS default filesystems are case-insensitive; Linux is case-sensitive. */
function comparable(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Expands a leading `~` (`~/pdfs` or `~\pdfs`) to the user's home directory on Windows,
 * macOS and Linux.
 */
export function expandHome(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/**
 * Normalizes path separators across platforms so an agent can send `"reports/2026"` or
 * `"reports\\2026"` regardless of whether the server runs on Windows, Linux or macOS.
 */
export function normalizeUserPath(inputPath: string): string {
  const expanded = expandHome(inputPath);
  if (process.platform !== 'win32') {
    return expanded.replace(/\\/g, '/');
  }
  return expanded;
}

/**
 * Resolves a user-supplied path (relative, `~`, or absolute) against `baseDir` using
 * cross-platform separator rules.
 */
export function resolveUserPath(baseDir: string, inputPath: string): string {
  const normalized = normalizeUserPath(inputPath);
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(baseDir, normalized);
}

/**
 * Canonicalizes a path even when its leaf folders do not exist yet, by resolving the
 * deepest existing ancestor with `realpathSync.native` and re-attaching the tail.
 * This keeps containment checks accurate across macOS (`/tmp` -> `/private/tmp`),
 * Linux symlinks and Windows 8.3 short paths (`RUNNER~1`).
 */
export function canonicalPathSync(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const tail: string[] = [];
  let current = resolved;
  while (true) {
    try {
      const real = fsSync.realpathSync.native(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `candidate` is `parent` itself or lives underneath it (symlink/8.3 aware). */
export function isWithin(parent: string, candidate: string): boolean {
  const canonicalParent = canonicalPathSync(parent);
  const canonicalCandidate = canonicalPathSync(candidate);
  const relative = comparable(path.relative(canonicalParent, canonicalCandidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Resolves, canonicalizes and deduplicates paths (case-aware on Windows). */
export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    if (!item || !item.trim()) continue;
    const resolved = canonicalPathSync(normalizeUserPath(item));
    const key = comparable(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

/** Relative path with forward slashes, which is what MCP clients and docs expect. */
export function relativePosix(parent: string, candidate: string): string {
  return path.relative(canonicalPathSync(parent), canonicalPathSync(candidate)).split(path.sep).join('/');
}

/**
 * Path relative to the workspace when it is inside it, otherwise the absolute path.
 * Agents get a short, portable value plus the absolute one when they need it.
 */
export function displayPath(parent: string, candidate: string): string {
  if (!isWithin(parent, candidate)) return candidate;
  const relative = relativePosix(parent, candidate);
  return relative === '' ? '.' : relative;
}

/** Converts an MCP `file://` root URI to a filesystem path on Windows, macOS or Linux. */
export function pathFromFileUri(uri: string): string | undefined {
  if (!/^file:/i.test(uri)) return undefined;
  try {
    return canonicalPathSync(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

/**
 * Splits a `PDF_MCP_ALLOWED_DIRS` value on newlines, `;` and `:` (without splitting
 * Windows drive letters such as `C:\...` or `C:/...`). Works identically on Windows,
 * macOS and Linux.
 */
export function splitPathList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[\r\n;]|(?<!(?:^|[\r\n;:])\s*[A-Za-z]):/g)
    .map((item) => item.trim())
    .filter(Boolean);
}
