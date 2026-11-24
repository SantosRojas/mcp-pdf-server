import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { renderPdf } from '../engine/render.js';
import { buildCodeMarkdown, codeSidecarPath, collectCodeBlocks } from '../engine/codeExport.js';
import { validatePdfAst } from '../engine/validate.js';
import type { GeneratePdfInput } from '../schemas/ast.js';
import { defaultWorkspace, type WorkspaceInfo } from '../runtime/workspace.js';
import { atomicWrite, resolveOutputFile } from '../utils/files.js';
import { displayPath } from '../utils/paths.js';
import { AppError } from '../utils/errors.js';

interface CodeExportResult {
  kind: 'sidecar' | 'embedded';
  path?: string;
  name?: string;
  blocks: number;
  bytes: number;
}

/** Embeds the companion source file inside the PDF (visible in the reader's attachments panel). */
async function attachCodeSource(pdfBytes: Buffer, name: string, markdown: string): Promise<Buffer> {
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
  await pdf.attach(Buffer.from(markdown, 'utf8'), name, {
    mimeType: 'text/markdown',
    description: 'Código fuente exacto de los bloques CodeBlock del documento',
    creationDate: new Date(),
    modificationDate: new Date()
  });
  return Buffer.from(await pdf.save());
}

export async function generatePdf(input: GeneratePdfInput, workspace: WorkspaceInfo = defaultWorkspace()): Promise<Record<string, unknown>> {
  const validation = validatePdfAst(input);
  if (!validation.valid) throw new AppError('El AST contiene errores de validación. Corrige los campos indicados y vuelve a intentarlo.', 'AST_VALIDATION_FAILED', undefined, validation.errors);
  const targetPath = await resolveOutputFile(workspace, input.filename, input.outputDir, input.overwrite);
  const rendered = await renderPdf(input);
  const warnings = [...validation.warnings, ...rendered.warnings];
  let pdfBytes = rendered.bytes;
  const codeExports: CodeExportResult[] = [];
  const blocks = collectCodeBlocks(input.content);
  const mode = input.settings.codeExport;
  if (blocks.length > 0 && mode !== 'none') {
    const documentTitle = input.metadata?.title ?? path.basename(targetPath, path.extname(targetPath));
    const markdown = buildCodeMarkdown(blocks, documentTitle);
    const markdownBytes = Buffer.from(markdown, 'utf8');
    const sidecarPath = codeSidecarPath(targetPath);
    if (mode === 'sidecar' || mode === 'both') {
      // The sidecar is derived from the same AST, so a regenerated PDF replaces it.
      await atomicWrite(sidecarPath, markdownBytes, true);
      codeExports.push({ kind: 'sidecar', path: sidecarPath, blocks: blocks.length, bytes: markdownBytes.byteLength });
    }
    if (mode === 'embedded' || mode === 'both') {
      pdfBytes = await attachCodeSource(pdfBytes, path.basename(sidecarPath), markdown);
      codeExports.push({ kind: 'embedded', name: path.basename(sidecarPath), blocks: blocks.length, bytes: markdownBytes.byteLength });
    }
  } else if (blocks.length > 0) {
    warnings.push(`El documento contiene ${blocks.length} bloque(s) de código. La numeración ya no se copia, pero las líneas que se ajustan al ancho se parten al copiar: activa settings.codeExport='sidecar' o 'embedded' para obtener el fuente exacto.`);
  }
  await atomicWrite(targetPath, pdfBytes, input.overwrite);
  return {
    success: true,
    path: targetPath,
    relativePath: displayPath(workspace.primaryRoot, targetPath),
    outputDir: path.dirname(targetPath),
    filename: path.basename(targetPath),
    pages: rendered.pageCount,
    bytes: pdfBytes.byteLength,
    sizeHuman: `${(pdfBytes.byteLength / 1024).toFixed(1)} KB`,
    ...(codeExports.length > 0 ? { codeExports } : {}),
    warnings
  };
}
