import path from 'node:path';
import { renderPdf } from '../engine/render.js';
import { validatePdfAst } from '../engine/validate.js';
import type { GeneratePdfInput } from '../schemas/ast.js';
import { atomicWrite, resolveOutputFile } from '../utils/files.js';
import { AppError } from '../utils/errors.js';

export async function generatePdf(input: GeneratePdfInput): Promise<Record<string, unknown>> {
  const validation = validatePdfAst(input);
  if (!validation.valid) throw new AppError('El AST contiene errores de validación. Corrige los campos indicados y vuelve a intentarlo.', 'AST_VALIDATION_FAILED', undefined, validation.errors);
  const targetPath = await resolveOutputFile(input.filename, input.outputDir, input.overwrite);
  const rendered = await renderPdf(input);
  await atomicWrite(targetPath, rendered.bytes, input.overwrite);
  return {
    success: true,
    path: targetPath,
    filename: path.basename(targetPath),
    pages: rendered.pageCount,
    bytes: rendered.bytes.byteLength,
    sizeHuman: `${(rendered.bytes.byteLength / 1024).toFixed(1)} KB`,
    warnings: [...validation.warnings, ...rendered.warnings]
  };
}
