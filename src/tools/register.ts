import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { componentCatalog, documentFeatures } from '../components/catalog.js';
import { getComponentSchema } from '../engine/validate.js';
import { listPdfComponents } from './listComponents.js';
import { validateAst } from './validateAst.js';
import { generatePdf } from './generatePdf.js';
import { mergePdfs } from './mergePdfs.js';
import { applyPdfSecurity } from './securityPdf.js';
import { generatePdfInputSchema, mergePdfsInputSchema, securityPdfInputSchema, securityPdfToolInputSchema, validatePdfAstInputSchema } from '../schemas/ast.js';
import { errorPayload } from '../utils/errors.js';
import { config } from '../config.js';

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: errorPayload(error) }, null, 2) }] };
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try { return await work(); }
    finally { this.active -= 1; this.waiters.shift()?.(); }
  }
}

const renderSemaphore = new Semaphore(config.maxConcurrentRenders);

export function registerPdfTools(server: McpServer): void {
  server.registerTool(
    'list_pdf_components',
    {
      description: 'Lista el catálogo de componentes PDF, sus categorías, propiedades requeridas/opcionales, ejemplos y esquema JSON. Consulta esta herramienta antes de construir el AST.',
      inputSchema: z.object({ category: z.enum(['layout', 'data', 'technical', 'media', 'typography', 'all']).optional() }).strict()
    },
    async ({ category }) => {
      try {
        const selected = listPdfComponents(category) as Record<string, unknown>;
        return ok({ ...selected, features: documentFeatures, componentCount: category && category !== 'all' ? componentCatalog.filter((item) => item.category === category).length : componentCatalog.length });
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    'validate_pdf_ast',
    {
      description: 'Valida el documento AST sin renderizar. Devuelve errores con path exacto y advertencias para autocorrección del agente.',
      inputSchema: validatePdfAstInputSchema
    },
    async (input) => {
      try {
        const result = validateAst(input);
        return ok({ ...result, message: result.valid ? 'AST válido; listo para generate_pdf.' : 'AST inválido; corrige los errores antes de generar.' });
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    'generate_pdf',
    {
      description: 'Genera un PDF profesional a partir de un AST JSON declarativo. No acepta HTML, CSS, JavaScript ni código ejecutable.',
      inputSchema: generatePdfInputSchema
    },
    async (input) => {
      try { return ok(await renderSemaphore.run(() => generatePdf(generatePdfInputSchema.parse(input)))); }
      catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    'merge_pdfs',
    {
      description: 'Combina dos o más PDFs existentes dentro del directorio seguro de salida. Mantiene el orden recibido.',
      inputSchema: mergePdfsInputSchema
    },
    async (input) => {
      try { return ok(await mergePdfs(mergePdfsInputSchema.parse(input))); }
      catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    'apply_pdf_security',
    {
      description: 'Actualiza metadatos y opcionalmente cifra el PDF con AES-256 y restricciones de impresión/copia. El cifrado requiere qpdf instalado.',
      inputSchema: securityPdfToolInputSchema
    },
    async (input) => {
      try { return ok(await applyPdfSecurity(securityPdfInputSchema.parse(input)));}
      catch (error) { return fail(error); }
    }
  );
}

export function getCatalogPayload() {
  return { components: componentCatalog, features: documentFeatures, schema: getComponentSchema() };
}
