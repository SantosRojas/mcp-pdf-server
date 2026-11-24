import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { AppError } from './errors.js';

function isForeignOsPath(command: string): boolean {
  if (process.platform === 'win32') return command.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(command) || command.includes('\\');
}

function windowsProgramFilesCandidates(): string[] {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']
    .filter((value): value is string => Boolean(value));
  const candidates: string[] = [];
  for (const root of new Set(roots)) {
    try {
      const dirs = fsSync.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^qpdf/i.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const dir of dirs) {
        candidates.push(path.join(root, dir, 'bin', 'qpdf.exe'));
      }
    } catch { /* unreadable root */ }
  }
  candidates.push(
    'C:\\ProgramData\\chocolatey\\bin\\qpdf.exe',
    path.join(os.homedir(), 'scoop', 'shims', 'qpdf.exe')
  );
  return candidates;
}

function platformFallbacks(): string[] {
  if (process.platform === 'win32') return windowsProgramFilesCandidates();
  if (process.platform === 'darwin') return ['/opt/homebrew/bin/qpdf', '/usr/local/bin/qpdf', '/opt/local/bin/qpdf', '/usr/bin/qpdf'];
  return ['/usr/bin/qpdf', '/usr/local/bin/qpdf', '/snap/bin/qpdf'];
}

function probeCommand(command: string): Promise<{ available: boolean; command: string; version?: string }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (result: { available: boolean; command: string; version?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (output.length < 200) output += chunk.slice(0, 200); });
    child.on('error', () => finish({ available: false, command }));
    child.on('close', (code) => {
      const firstLine = output.trim().split(/\r?\n/)[0]?.trim();
      finish(code === 0 ? (firstLine ? { available: true, command, version: firstLine } : { available: true, command }) : { available: false, command });
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ available: false, command }); }, 3_000);
    timer.unref();
  });
}

let probe: Promise<{ available: boolean; command: string; version?: string }> | undefined;

/**
 * Cross-platform qpdf discovery:
 * - If `QPDF_PATH` is the default (`qpdf`) or a path from another OS, searches `PATH`
 *   and standard OS locations (Windows Program Files/Scoop/Choco, macOS Homebrew/MacPorts,
 *   Linux `/usr/bin`, `/usr/local/bin`, `/snap/bin`).
 * - If `QPDF_PATH` is an explicit path/command for the current OS, honours it directly.
 */
export function probeQpdf(): Promise<{ available: boolean; command: string; version?: string }> {
  if (probe) return probe;
  probe = (async () => {
    const configured = config.qpdfPath.trim();
    const isDefaultOrForeign = !configured || configured === 'qpdf' || configured === 'qpdf.exe' || isForeignOsPath(configured);
    if (!isDefaultOrForeign) {
      return probeCommand(configured);
    }
    const candidates: string[] = ['qpdf'];
    for (const candidate of platformFallbacks()) {
      if (fsSync.existsSync(candidate) && !candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
    for (const candidate of candidates) {
      const result = await probeCommand(candidate);
      if (result.available) return result;
    }
    return { available: false, command: 'qpdf' };
  })();
  return probe;
}

/**
 * Formats qpdf arguments as newline-delimited lines for `@-` stdin delivery so sensitive
 * passwords never appear in OS process command-line arguments (`ps` / `/proc/<pid>/cmdline`).
 */
export function serializeQpdfArgFile(args: readonly string[]): string {
  for (const arg of args) {
    if (/[\r\n\0]/.test(arg)) {
      throw new AppError('Los argumentos de qpdf no pueden contener saltos de línea ni caracteres nulos.', 'QPDF_INVALID_ARGUMENT');
    }
  }
  return `${args.join('\n')}\n`;
}

export function supportsNamedPasswordFlags(versionString?: string): boolean {
  const match = versionString?.match(/version\s+(\d+)\.(\d+)/i);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 11 || (major === 11 && minor >= 7);
}

export async function buildQpdfEncryptArgs(options: {
  userPassword?: string;
  ownerPassword?: string;
  printing: boolean;
  copying: boolean;
  inputPath: string;
  outputPath: string;
}): Promise<string[]> {
  const user = options.userPassword ?? '';
  const owner = options.ownerPassword ?? '';
  const resolved = await probeQpdf();
  const permFlags = [
    `--print=${options.printing ? 'full' : 'none'}`,
    `--extract=${options.copying ? 'y' : 'n'}`,
    '--modify=none',
    '--annotate=n',
    '--',
    options.inputPath,
    options.outputPath
  ];
  if (supportsNamedPasswordFlags(resolved.version)) {
    return [
      '--encrypt',
      ...(user ? [`--user-password=${user}`] : []),
      ...(owner ? [`--owner-password=${owner}`] : []),
      '--bits=256',
      ...permFlags
    ];
  }
  if (user.startsWith('-') || owner.startsWith('-')) {
    throw new AppError('Con versiones de qpdf anteriores a 11.7 las contraseñas no pueden comenzar con "-". Actualiza qpdf a >= 11.7.', 'QPDF_INVALID_ARGUMENT');
  }
  return ['--encrypt', user, owner, '256', ...permFlags];
}

/** Runs qpdf with a hard timeout, delivering arguments through `@-` stdin instead of argv. */
export async function runQpdf(args: readonly string[]): Promise<void> {
  const stdinPayload = serializeQpdfArgFile(args);
  const resolved = await probeQpdf();
  const executable = resolved.command;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['@-'], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve();
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 4_000) stderr += chunk.slice(0, 4_000 - stderr.length); });
    child.stdin.on('error', () => { /* handled via process close/error if qpdf exits early */ });
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') finish(new AppError('No se encontró qpdf. Instálalo en el sistema (apt/brew/winget/choco) o configura QPDF_PATH; el cifrado PDF requiere qpdf.', 'QPDF_NOT_INSTALLED'));
      else finish(error);
    });
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new AppError(`qpdf terminó con código ${code}: ${stderr.trim() || 'sin detalle'}`, 'QPDF_FAILED'));
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new AppError(`qpdf excedió el límite de ${config.qpdfTimeoutMs} ms y fue terminado.`, 'QPDF_TIMEOUT'));
    }, config.qpdfTimeoutMs);
    timeout.unref();
    child.stdin.end(stdinPayload, 'utf8');
  });
}
