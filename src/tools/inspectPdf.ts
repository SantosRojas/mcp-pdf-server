import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import type { InspectPdfInput } from '../schemas/ast.js';
import { defaultWorkspace, type WorkspaceInfo } from '../runtime/workspace.js';
import { resolveExistingPdf } from '../utils/files.js';
import { displayPath } from '../utils/paths.js';
import { AppError } from '../utils/errors.js';

export interface PageInspection {
  page: number;
  width: number;
  height: number;
  orientation: 'portrait' | 'landscape';
  charCount?: number;
  wordCount?: number;
  fillEstimate?: 'empty' | 'sparse' | 'moderate' | 'dense';
  textPreview?: string;
}

export interface LayoutDiagnostic {
  code: 'EMPTY_PAGE' | 'SPARSE_TRAILING_PAGE';
  page: number;
  message: string;
}

function classifyFill(chars: number): 'empty' | 'sparse' | 'moderate' | 'dense' {
  if (chars === 0) return 'empty';
  if (chars < 120) return 'sparse';
  if (chars < 1_200) return 'moderate';
  return 'dense';
}

/**
 * Inspects an existing PDF so AI agents can verify page count, page orientation/dimensions,
 * extracted text density, and orphan/sparse trailing pages for layout self-correction.
 */
export async function inspectPdfDocument(
  input: InspectPdfInput,
  workspace: WorkspaceInfo = defaultWorkspace()
): Promise<Record<string, unknown>> {
  const sourcePath = await resolveExistingPdf(workspace, input.filePath);
  const bytes = await fs.readFile(sourcePath);
  const maxPages = input.maxPages ?? 30;
  const includeTextPreview = input.includeTextPreview !== false;

  let pdf: PDFDocument;
  let encrypted = false;
  try {
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch {
    try {
      pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      encrypted = true;
    } catch {
      throw new AppError('No se pudo analizar la estructura del archivo PDF.', 'PDF_PARSE_FAILED');
    }
  }

  const totalPages = pdf.getPageCount();
  const inspectedCount = Math.min(totalPages, maxPages);
  const pageList = pdf.getPages().slice(0, inspectedCount);

  const pages: PageInspection[] = pageList.map((page, idx) => {
    const { width, height } = page.getSize();
    const w = Math.round(width * 100) / 100;
    const h = Math.round(height * 100) / 100;
    return {
      page: idx + 1,
      width: w,
      height: h,
      orientation: w > h ? 'landscape' : 'portrait'
    };
  });

  const layoutWarnings: LayoutDiagnostic[] = [];
  let textLayerAvailable = false;

  if (!encrypted) {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => null);
    if (pdfjs && typeof pdfjs.getDocument === 'function') {
      const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
      try {
        const doc = await task.promise;
        textLayerAvailable = true;
        for (let i = 0; i < inspectedCount; i += 1) {
          const p = await doc.getPage(i + 1);
          const content = await p.getTextContent();
          const rawText = content.items
            .map((item: unknown) => (item && typeof item === 'object' && 'str' in item ? String((item as { str: unknown }).str) : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          const nonSpaceChars = rawText.replace(/\s+/g, '').length;
          const words = rawText ? rawText.split(/\s+/).length : 0;
          const target = pages[i]!;
          target.charCount = nonSpaceChars;
          target.wordCount = words;
          target.fillEstimate = classifyFill(nonSpaceChars);
          if (includeTextPreview) {
            target.textPreview = rawText.slice(0, 280);
          }
          if (nonSpaceChars === 0) {
            layoutWarnings.push({
              code: 'EMPTY_PAGE',
              page: i + 1,
              message: `La página ${i + 1} no contiene texto extraíble; verifica si hay un PageBreak innecesario o solo elementos gráficos.`
            });
          }
        }
      } finally {
        await task.destroy().catch(() => undefined);
      }
    }
  }

  if (textLayerAvailable && totalPages >= 2 && inspectedCount === totalPages) {
    const last = pages[pages.length - 1]!;
    const prev = pages[pages.length - 2]!;
    if ((last.charCount ?? 0) > 0 && (last.charCount ?? 0) < 90 && (prev.charCount ?? 0) >= 150) {
      layoutWarnings.push({
        code: 'SPARSE_TRAILING_PAGE',
        page: totalPages,
        message: `La última página (${totalPages}) tiene muy poco contenido (${last.charCount} caracteres); considera compactar márgenes/tablas o ajustar saltos de página para evitar líneas huérfanas.`
      });
    }
  }

  return {
    success: true,
    path: sourcePath,
    relativePath: displayPath(workspace.primaryRoot, sourcePath),
    filename: path.basename(sourcePath),
    bytes: bytes.byteLength,
    sizeHuman: `${(bytes.byteLength / 1024).toFixed(1)} KB`,
    pages: totalPages,
    inspectedPages: inspectedCount,
    encrypted,
    textLayerAvailable,
    metadata: {
      title: pdf.getTitle() ?? null,
      author: pdf.getAuthor() ?? null,
      subject: pdf.getSubject() ?? null,
      keywords: pdf.getKeywords() ?? null
    },
    pageDetails: pages,
    layoutWarnings
  };
}
