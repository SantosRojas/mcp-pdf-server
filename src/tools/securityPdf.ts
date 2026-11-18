import path from 'node:path';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import type { SecurityPdfInput } from '../schemas/ast.js';
import { config } from '../config.js';
import { atomicWrite, createTempPath, resolveExistingPdf, resolveOutputFile } from '../utils/files.js';
import { AppError } from '../utils/errors.js';

function runQpdf(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.qpdfPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
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
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') finish(new AppError('No se encontró qpdf. Instálalo en el sistema y configura QPDF_PATH; el cifrado PDF requiere qpdf.', 'QPDF_NOT_INSTALLED'));
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
  });
}

export async function applyPdfSecurity(input: SecurityPdfInput): Promise<Record<string, unknown>> {
  const sourcePath = await resolveExistingPdf(input.filePath);
  const outputName = input.outputFilename ?? `${path.basename(sourcePath, '.pdf')}-secured.pdf`;
  const targetPath = await resolveOutputFile(outputName, undefined, input.overwrite);
  const sourceBytes = await fs.readFile(sourcePath);
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(sourceBytes); }
  catch { throw new AppError('No se pudo abrir el PDF. Si está cifrado, descífralo antes de aplicar esta operación.', 'PDF_PARSE_FAILED'); }
  if (input.metadata?.title) pdf.setTitle(input.metadata.title);
  if (input.metadata?.author) pdf.setAuthor(input.metadata.author);
  if (input.metadata?.subject) pdf.setSubject(input.metadata.subject);
  if (input.metadata?.keywords) pdf.setKeywords(input.metadata.keywords);
  const metadataBytes = Buffer.from(await pdf.save({ useObjectStreams: true }));
  const needsEncryption = Boolean(input.userPassword || input.ownerPassword || !input.permissions.printing || !input.permissions.copying);
  if (!needsEncryption) {
    await atomicWrite(targetPath, metadataBytes, input.overwrite);
    return { success: true, path: targetPath, filename: path.basename(targetPath), encrypted: false, metadataUpdated: Boolean(input.metadata) };
  }

  // qpdf receives passwords as process arguments. Run this service with a dedicated OS account.
  const tempInput = await createTempPath('security-input');
  const tempOutput = await createTempPath('security-output');
  try {
    await fs.writeFile(tempInput, metadataBytes, { mode: 0o600, flag: 'wx' });
    const args = [
      '--encrypt', input.userPassword ?? '', input.ownerPassword ?? '', '256',
      `--print=${input.permissions.printing ? 'full' : 'none'}`,
      `--extract=${input.permissions.copying ? 'y' : 'n'}`,
      '--modify=none', '--annotate=n', '--', tempInput, tempOutput
    ];
    await runQpdf(args);
    const outputBytes = await fs.readFile(tempOutput);
    if (outputBytes.length < 100 || outputBytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new AppError('qpdf no generó un PDF válido.', 'QPDF_INVALID_OUTPUT');
    await atomicWrite(targetPath, outputBytes, input.overwrite);
    return { success: true, path: targetPath, filename: path.basename(targetPath), encrypted: true, algorithm: 'AES-256', permissions: input.permissions, bytes: outputBytes.length };
  } finally {
    await fs.rm(tempInput, { force: true }).catch(() => undefined);
    await fs.rm(tempOutput, { force: true }).catch(() => undefined);
  }
}
