import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from './errors.js';

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function ensureOutputRoot(): Promise<string> {
  await fs.mkdir(config.outputDir, { recursive: true, mode: 0o750 });
  return fs.realpath(config.outputDir);
}

export async function resolveOutputDirectory(requested?: string): Promise<string> {
  const root = await ensureOutputRoot();
  const candidate = requested ? path.resolve(root, requested) : root;
  if (!isWithin(root, candidate)) throw new AppError('outputDir debe permanecer dentro de PDF_MCP_OUTPUT_DIR.', 'PATH_OUTSIDE_SANDBOX', 'outputDir');
  await fs.mkdir(candidate, { recursive: true, mode: 0o750 });
  const real = await fs.realpath(candidate);
  if (!isWithin(root, real)) throw new AppError('El directorio de salida resuelve fuera del sandbox permitido.', 'PATH_OUTSIDE_SANDBOX', 'outputDir');
  return real;
}

export function safePdfFilename(filename: string): string {
  const cleaned = filename.trim().replace(/\.pdf$/i, '').normalize('NFKC');
  if (!cleaned || cleaned === '.' || cleaned === '..' || /[\\/\0]/.test(cleaned)) {
    throw new AppError('Nombre de archivo no válido.', 'INVALID_FILENAME', 'filename');
  }
  return `${cleaned}.pdf`;
}

export async function resolveOutputFile(filename: string, requestedDir?: string, overwrite = false): Promise<string> {
  const directory = await resolveOutputDirectory(requestedDir);
  const target = path.join(directory, safePdfFilename(filename));
  if (!isWithin(await ensureOutputRoot(), target)) throw new AppError('Ruta de salida fuera del sandbox.', 'PATH_OUTSIDE_SANDBOX');
  try {
    await fs.lstat(target);
    if (!overwrite) throw new AppError(`El archivo ya existe: ${path.basename(target)}. Usa overwrite=true para reemplazarlo.`, 'FILE_EXISTS');
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const realParent = await fs.realpath(path.dirname(target));
  if (!isWithin(await ensureOutputRoot(), realParent)) throw new AppError('La carpeta de destino escapa del sandbox.', 'PATH_OUTSIDE_SANDBOX');
  return target;
}

export async function resolveExistingPdf(inputPath: string): Promise<string> {
  const root = await ensureOutputRoot();
  const candidate = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(root, inputPath);
  if (!isWithin(root, candidate)) throw new AppError('Solo se permiten PDFs dentro de PDF_MCP_OUTPUT_DIR.', 'PATH_OUTSIDE_SANDBOX', 'filePath');
  const real = await fs.realpath(candidate).catch(() => { throw new AppError(`No existe el archivo: ${inputPath}`, 'FILE_NOT_FOUND', 'filePath'); });
  if (!isWithin(root, real)) throw new AppError('El archivo resuelve fuera del sandbox.', 'PATH_OUTSIDE_SANDBOX', 'filePath');
  const stat = await fs.stat(real);
  if (!stat.isFile() || path.extname(real).toLowerCase() !== '.pdf') throw new AppError('La ruta debe apuntar a un archivo PDF.', 'INVALID_FILE_TYPE', 'filePath');
  if (stat.size > config.maxInputBytes) throw new AppError(`El PDF supera el límite de ${config.maxInputBytes} bytes.`, 'INPUT_TOO_LARGE', 'filePath');
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
      await fs.link(tempPath, targetPath);
      await fs.unlink(tempPath);
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createTempPath(prefix = 'mcp-pdf'): Promise<string> {
  const root = await ensureOutputRoot();
  return path.join(root, `.${prefix}-${randomUUID()}.tmp.pdf`);
}

export async function assertWithinOutputRoot(filePath: string): Promise<void> {
  const root = await ensureOutputRoot();
  const real = await fs.realpath(filePath);
  if (!isWithin(root, real)) throw new AppError('Operación fuera del sandbox de archivos.', 'PATH_OUTSIDE_SANDBOX');
}
