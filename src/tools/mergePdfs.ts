import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import type { MergePdfsInput } from '../schemas/ast.js';
import { atomicWrite, resolveExistingPdf, resolveOutputFile } from '../utils/files.js';
import { AppError } from '../utils/errors.js';

export async function mergePdfs(input: MergePdfsInput): Promise<Record<string, unknown>> {
  const sourcePaths = await Promise.all(input.filePaths.map(resolveExistingPdf));
  let aggregateBytes = 0;
  for (const sourcePath of sourcePaths) {
    const stat = await fs.stat(sourcePath);
    aggregateBytes += stat.size;
    if (aggregateBytes > 250 * 1024 * 1024) throw new AppError('La operación de merge supera el límite agregado de 250 MiB.', 'MERGE_INPUT_LIMIT');
  }
  const merged = await PDFDocument.create();
  merged.setCreator('mcp-pdf-server');
  merged.setProducer('pdf-lib');
  let totalPages = 0;
  for (const sourcePath of sourcePaths) {
    const bytes = await fs.readFile(sourcePath);
    let source: PDFDocument;
    try { source = await PDFDocument.load(bytes); }
    catch { throw new AppError(`No se pudo leer ${path.basename(sourcePath)}. Verifica que sea un PDF válido y no esté cifrado.`, 'PDF_PARSE_FAILED', sourcePath); }
    const indices = source.getPageIndices();
    totalPages += indices.length;
    if (totalPages > 2_500) throw new AppError('La operación supera el límite de 2500 páginas.', 'PAGE_LIMIT_EXCEEDED');
    const pages = await merged.copyPages(source, indices);
    pages.forEach((page) => merged.addPage(page));
  }
  const targetPath = await resolveOutputFile(input.outputFilename, undefined, input.overwrite);
  const bytes = Buffer.from(await merged.save({ useObjectStreams: true }));
  await atomicWrite(targetPath, bytes, input.overwrite);
  return { success: true, path: targetPath, filename: path.basename(targetPath), pages: totalPages, bytes: bytes.byteLength };
}
