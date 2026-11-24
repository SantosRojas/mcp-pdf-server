import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { isPathAllowed, type WorkspaceInfo } from '../runtime/workspace.js';
import { displayPath, isWithin, normalizeUserPath, resolveUserPath, uniquePaths } from './paths.js';
import { AppError } from './errors.js';

const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'venv', '.venv', '__pycache__', '.cache', '.idea', '.vscode'
]);

const MAX_SCAN_DEPTH = 5;

function pathError(workspace: WorkspaceInfo, field: string, message: string): AppError {
  return new AppError(message, 'PATH_OUTSIDE_SANDBOX', field, {
    allowedRoots: workspace.allowedRoots,
    allowAnyPath: workspace.allowAnyPath,
    hint: 'Usa una ruta relativa al workspace (por ejemplo "output" o "reports/2026"), una ruta absoluta dentro del workspace, o declara la carpeta en PDF_MCP_ALLOWED_DIRS.'
  });
}

function assertAllowed(workspace: WorkspaceInfo, candidate: string, field: string): void {
  if (!isPathAllowed(workspace, candidate)) {
    throw pathError(
      workspace,
      field,
      `La ruta "${candidate}" está fuera de las carpetas permitidas. Carpetas permitidas: ${workspace.allowedRoots.join(', ')}.`
    );
  }
}

async function realDirectory(directory: string, field: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o750 });
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) throw new AppError(`La ruta no es un directorio: ${directory}`, 'INVALID_OUTPUT_DIR', field);
  return fs.realpath(directory);
}

/**
 * Resolves the folder where a new PDF will be written.
 * - no `requested`: <workspace>/output (or PDF_MCP_OUTPUT_DIR).
 * - relative `requested`: resolved against the workspace root, so "reports/2026" works.
 * - absolute `requested`: accepted when it is inside the workspace or an allowed folder.
 */
export async function resolveOutputDirectory(workspace: WorkspaceInfo, requested?: string): Promise<string> {
  const candidate = requested
    ? resolveUserPath(workspace.primaryRoot, requested)
    : workspace.outputDir;
  assertAllowed(workspace, candidate, 'outputDir');
  const real = await realDirectory(candidate, 'outputDir');
  assertAllowed(workspace, real, 'outputDir');
  return real;
}

/** Resolves an existing directory for read-only tools such as `list_pdfs`. */
export async function resolveExistingDirectory(workspace: WorkspaceInfo, requested: string): Promise<string> {
  const candidate = resolveUserPath(workspace.primaryRoot, requested);
  assertAllowed(workspace, candidate, 'directory');
  const real = await fs.realpath(candidate).catch(() => {
    throw new AppError(`No existe la carpeta: ${requested}`, 'DIRECTORY_NOT_FOUND', 'directory', {
      allowedRoots: workspace.allowedRoots
    });
  });
  assertAllowed(workspace, real, 'directory');
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new AppError(`La ruta no es una carpeta: ${requested}`, 'INVALID_OUTPUT_DIR', 'directory');
  return real;
}

export function safePdfFilename(filename: string): string {
  const cleaned = filename.trim().replace(/\.pdf$/i, '').normalize('NFKC');
  if (!cleaned || cleaned === '.' || cleaned === '..' || /[\\/\0]/.test(cleaned)) {
    throw new AppError('Nombre de archivo no válido.', 'INVALID_FILENAME', 'filename');
  }
  return `${cleaned}.pdf`;
}

export async function resolveOutputFile(
  workspace: WorkspaceInfo,
  filename: string,
  requestedDir?: string,
  overwrite = false
): Promise<string> {
  const directory = await resolveOutputDirectory(workspace, requestedDir);
  const target = path.join(directory, safePdfFilename(filename));
  assertAllowed(workspace, target, 'filename');
  try {
    await fs.lstat(target);
    if (!overwrite) throw new AppError(`El archivo ya existe: ${path.basename(target)}. Usa overwrite=true para reemplazarlo.`, 'FILE_EXISTS', 'filename', {
      path: target,
      relativePath: displayPath(workspace.primaryRoot, target)
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const realParent = await fs.realpath(path.dirname(target));
  assertAllowed(workspace, realParent, 'outputDir');
  return target;
}

/**
 * Resolves a PDF that already exists. Absolute paths must be inside an allowed folder;
 * relative paths are searched in the workspace root, the output folder and any extra
 * allowed directory, so agents do not need to know the exact layout.
 */
export async function resolveExistingPdf(workspace: WorkspaceInfo, inputPath: string): Promise<string> {
  const normalized = normalizeUserPath(inputPath);
  const candidates = path.isAbsolute(normalized)
    ? [path.resolve(normalized)]
    : uniquePaths(workspace.searchRoots.map((root) => resolveUserPath(root, normalized)));
  let found: string | undefined;
  for (const candidate of candidates) {
    if (!isPathAllowed(workspace, candidate)) continue;
    const stat = await fs.stat(candidate).catch(() => undefined);
    if (stat?.isFile()) { found = candidate; break; }
  }
  if (!found) {
    const allowedCandidate = candidates.find((candidate) => isPathAllowed(workspace, candidate));
    if (!allowedCandidate && candidates.length > 0) {
      throw pathError(
        workspace,
        'filePath',
        `La ruta "${inputPath}" está fuera de las carpetas permitidas. Carpetas permitidas: ${workspace.allowedRoots.join(', ')}.`
      );
    }
    throw new AppError(`No existe el archivo: ${inputPath}`, 'FILE_NOT_FOUND', 'filePath', {
      searchedIn: candidates,
      hint: 'Usa list_pdfs para ver los PDFs disponibles o pasa una ruta relativa al workspace.'
    });
  }
  const real = await fs.realpath(found);
  assertAllowed(workspace, real, 'filePath');
  const stat = await fs.stat(real);
  if (!stat.isFile() || path.extname(real).toLowerCase() !== '.pdf') {
    throw new AppError('La ruta debe apuntar a un archivo PDF.', 'INVALID_FILE_TYPE', 'filePath');
  }
  if (stat.size > config.maxInputBytes) {
    throw new AppError(`El PDF supera el límite de ${config.maxInputBytes} bytes.`, 'INPUT_TOO_LARGE', 'filePath');
  }
  return real;
}

export async function atomicWrite(targetPath: string, data: Uint8Array, overwrite = false): Promise<void> {
  if (data.byteLength > config.maxOutputBytes) throw new AppError(`El PDF supera el límite de salida de ${config.maxOutputBytes} bytes.`, 'OUTPUT_TOO_LARGE');
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, data, { mode: 0o640, flag: 'wx' });
    if (overwrite) {
      await fs.rename(tempPath, targetPath);
    } else {
      try {
        await fs.link(tempPath, targetPath);
        await fs.unlink(tempPath);
      } catch (linkError) {
        const code = (linkError as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EXDEV') {
          // Filesystems without hard-link support (FAT/exFAT, some SMB/Docker mounts).
          const exists = await fs.lstat(targetPath).then(() => true, () => false);
          if (exists) throw new AppError(`El archivo ya existe: ${path.basename(targetPath)}. Usa overwrite=true para reemplazarlo.`, 'FILE_EXISTS');
          await fs.rename(tempPath, targetPath);
        } else {
          throw linkError;
        }
      }
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createTempPath(workspace: WorkspaceInfo, prefix = 'mcp-pdf'): Promise<string> {
  const root = await resolveOutputDirectory(workspace);
  return path.join(root, `.${prefix}-${randomUUID()}.tmp.pdf`);
}

export interface ListPdfsOptions {
  directory?: string | undefined;
  recursive: boolean;
  limit: number;
}

export interface PdfFileEntry {
  path: string;
  relativePath: string;
  filename: string;
  bytes: number;
  modifiedAt: string;
}

export interface ListPdfsResult {
  scannedRoots: string[];
  files: PdfFileEntry[];
  truncated: boolean;
}

async function walkPdfs(
  workspace: WorkspaceInfo,
  directory: string,
  depth: number,
  maxDepth: number,
  output: Map<string, PdfFileEntry>
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth >= maxDepth || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walkPdfs(workspace, absolute, depth + 1, maxDepth, output);
      continue;
    }
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.pdf') continue;
    if (entry.name.startsWith('.')) continue;
    const real = await fs.realpath(absolute).catch(() => undefined);
    if (!real || !isPathAllowed(workspace, real)) continue;
    const stat = await fs.stat(real).catch(() => undefined);
    if (!stat?.isFile()) continue;
    if (!output.has(real)) {
      output.set(real, {
        path: real,
        relativePath: displayPath(workspace.primaryRoot, real),
        filename: path.basename(real),
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
  }
}

/**
 * Lists PDFs that already exist inside the workspace or the allowed folders.
 * Agents use it to find documents for `merge_pdfs` / `apply_pdf_security` without
 * guessing paths.
 */
export async function listPdfFiles(workspace: WorkspaceInfo, options: ListPdfsOptions): Promise<ListPdfsResult> {
  const roots = options.directory
    ? [await resolveExistingDirectory(workspace, options.directory)]
    : (await Promise.all(workspace.searchRoots.map(async (root) => {
        const stat = await fs.stat(root).catch(() => undefined);
        return stat?.isDirectory() ? fs.realpath(root).catch(() => undefined) : undefined;
      }))).filter((value): value is string => typeof value === 'string');
  const scannedRoots = uniquePaths(roots);
  const found = new Map<string, PdfFileEntry>();
  for (const root of scannedRoots) {
    await walkPdfs(workspace, root, 0, options.recursive ? MAX_SCAN_DEPTH : 0, found);
  }
  const all = [...found.values()].sort((a, b) => {
    const byDate = b.modifiedAt.localeCompare(a.modifiedAt);
    return byDate !== 0 ? byDate : a.filename.localeCompare(b.filename);
  });
  return {
    scannedRoots,
    files: all.slice(0, options.limit),
    truncated: all.length > options.limit
  };
}

/** Kept for callers that only need to verify containment of a resolved path. */
export async function assertWithinAllowed(workspace: WorkspaceInfo, filePath: string): Promise<void> {
  const real = await fs.realpath(filePath);
  if (!isWithin(workspace.primaryRoot, real) && !isPathAllowed(workspace, real)) {
    throw pathError(workspace, 'filePath', 'Operación fuera de las carpetas permitidas.');
  }
}
