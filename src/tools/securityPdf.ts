import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import type { SecurityPdfInput } from '../schemas/ast.js';
import { defaultWorkspace, type WorkspaceInfo } from '../runtime/workspace.js';
import { atomicWrite, createTempPath, resolveExistingPdf, resolveOutputFile } from '../utils/files.js';
import { displayPath } from '../utils/paths.js';
import { buildQpdfEncryptArgs, runQpdf } from '../utils/qpdf.js';
import { AppError } from '../utils/errors.js';

export async function applyPdfSecurity(input: SecurityPdfInput, workspace: WorkspaceInfo = defaultWorkspace()): Promise<Record<string, unknown>> {
  const sourcePath = await resolveExistingPdf(workspace, input.filePath);
  const outputName = input.outputFilename ?? `${path.basename(sourcePath, '.pdf')}-secured.pdf`;
  const targetPath = await resolveOutputFile(workspace, outputName, input.outputDir, input.overwrite);
  const relativePath = displayPath(workspace.primaryRoot, targetPath);
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
    return { success: true, path: targetPath, relativePath, filename: path.basename(targetPath), encrypted: false, metadataUpdated: Boolean(input.metadata) };
  }

  // Passwords and flags are streamed to qpdf via `@-` stdin so they never appear in process argv.
  const tempInput = await createTempPath(workspace, 'security-input');
  const tempOutput = await createTempPath(workspace, 'security-output');
  try {
    await fs.writeFile(tempInput, metadataBytes, { mode: 0o600, flag: 'wx' });
    const args = await buildQpdfEncryptArgs({
      ...(input.userPassword !== undefined ? { userPassword: input.userPassword } : {}),
      ...(input.ownerPassword !== undefined ? { ownerPassword: input.ownerPassword } : {}),
      printing: input.permissions.printing,
      copying: input.permissions.copying,
      inputPath: tempInput,
      outputPath: tempOutput
    });
    await runQpdf(args);
    const outputBytes = await fs.readFile(tempOutput);
    if (outputBytes.length < 100 || outputBytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new AppError('qpdf no generó un PDF válido.', 'QPDF_INVALID_OUTPUT');
    await atomicWrite(targetPath, outputBytes, input.overwrite);
    return { success: true, path: targetPath, relativePath, filename: path.basename(targetPath), encrypted: true, algorithm: 'AES-256', permissions: input.permissions, bytes: outputBytes.length };
  } finally {
    await fs.rm(tempInput, { force: true }).catch(() => undefined);
    await fs.rm(tempOutput, { force: true }).catch(() => undefined);
  }
}
