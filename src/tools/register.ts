import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { componentCatalog, documentFeatures } from '../components/catalog.js';
import { getComponentSchema } from '../engine/validate.js';
import { getWorkspace } from '../runtime/workspace.js';
import { listPdfComponents } from './listComponents.js';
import { validateAst } from './validateAst.js';
import { generatePdf } from './generatePdf.js';
import { inspectPdfDocument } from './inspectPdf.js';
import { mergePdfs } from './mergePdfs.js';
import { applyPdfSecurity } from './securityPdf.js';
import { getServerInfo } from './serverInfo.js';
import { listPdfs } from './listPdfs.js';
import {
  generatePdfInputSchema,
  inspectPdfInputSchema,
  listPdfsInputSchema,
  mergePdfsInputSchema,
  securityPdfInputSchema,
  securityPdfToolInputSchema,
  serverInfoInputSchema,
  validatePdfAstInputSchema
} from '../schemas/ast.js';
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

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

export function registerPdfTools(server: McpServer): void {
  server.registerTool(
    'get_pdf_server_info',
    {
      title: 'Información del servidor PDF y workspace',
      description: 'Devuelve la versión del servidor, los workspace roots detectados, la carpeta de salida por defecto, las carpetas permitidas, las fuentes instaladas, los temas disponibles y el flujo recomendado. Llamar una vez al iniciar para saber exactamente dónde se guardarán los PDFs.',
      inputSchema: serverInfoInputSchema,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async () => {
      try { return ok(await getServerInfo(await getWorkspace(server))); }
      catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    'list_pdf_components',
    {
      title: 'Catálogo de componentes PDF',
      description: 'Lista el catálogo de 27 componentes PDF, sus categorías, propiedades requeridas/opcionales y ejemplos. Al filtrar por una categoría específica omite el JSON Schema completo para ahorrar tokens salvo que includeSchema=true.',
      inputSchema: z.object({
        category: z.enum(['layout', 'data', 'technical', 'media', 'typography', 'all']).optional(),
        includeSchema: z.boolean().optional()
      }).strict(),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ category, includeSchema }) => {
      try {
        const isAll = !category || category === 'all';
        const selected = listPdfComponents(category, Boolean(includeSchema)) as Record<string, unknown>;
        return ok({
          ...selected,
          ...(isAll || includeSchema ? { features: documentFeatures } : {}),
          componentCount: isAll ? componentCatalog.length : componentCatalog.filter((item) => item.category === category).length
        });
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    'validate_pdf_ast',
    {
      title: 'Validar AST PDF sin renderizar',
      description: 'Valida el documento AST sin renderizar. Devuelve errores con path exacto y advertencias semánticas (totales de factura, límites de imágenes/QR, activos ausentes, pesos de Grid) para autocorrección del agente.',
      inputSchema: validatePdfAstInputSchema,
      annotations: READ_ONLY_ANNOTATIONS
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
      title: 'Generar documento PDF profesional',
      description: 'Genera un PDF profesional a partir de un AST JSON declarativo (incluyendo CoverPage, TableOfContents, Markdown, DataTable, Chart, Flowchart y Section) y lo guarda en disco. Devuelve path absoluto, relativePath, páginas, outline de secciones, tamaño y warnings.',
      inputSchema: generatePdfInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: config.allowRemoteImages
      }
    },
    async (input) => {
      try {
        const workspace = await getWorkspace(server);
        return ok(await renderSemaphore.run(() => generatePdf(generatePdfInputSchema.parse(input), workspace, { preParsed: true })));
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    'inspect_pdf',
    {
      title: 'Inspeccionar estructura y paginación de un PDF',
      description: 'Analiza un PDF existente y devuelve metadatos, dimensiones/orientación por página, densidad de texto, vista previa de contenido y alertas de maquetación (como SPARSE_TRAILING_PAGE cuando la última página quedó casi vacía) para autocorrección del agente.',
      inputSchema: inspectPdfInputSchema,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (input) => {
      try {
        const workspace = await getWorkspace(server);
        return ok(await inspectPdfDocument(inspectPdfInputSchema.parse(input), workspace));
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    'list_pdfs',
    {
      title: 'Listar PDFs del workspace',
      description: 'Lista los PDFs existentes en el workspace, la carpeta de salida y las carpetas permitidas, con ruta absoluta, ruta relativa, tamaño y fecha.',
      inputSchema: listPdfsInputSchema,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (input) => {
      try {
        const workspace = await getWorkspace(server);
        return ok(await listPdfs(listPdfsInputSchema.parse(input), workspace));
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    'merge_pdfs',
    {
      title: 'Combinar múltiples PDFs',
      description: 'Combina dos o más PDFs existentes en un documento nuevo manteniendo el orden recibido.',
      inputSchema: mergePdfsInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) => {
      try {
        const workspace = await getWorkspace(server);
        return ok(await mergePdfs(mergePdfsInputSchema.parse(input), workspace));
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    'apply_pdf_security',
    {
      title: 'Aplicar metadatos y cifrado AES-256',
      description: 'Actualiza metadatos y opcionalmente cifra el PDF con AES-256 y restricciones de impresión/copia vía qpdf.',
      inputSchema: securityPdfToolInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) => {
      try {
        const workspace = await getWorkspace(server);
        return ok(await applyPdfSecurity(securityPdfInputSchema.parse(input), workspace));
      } catch (error) { return fail(error); }
    }
  );
}

export function getCatalogPayload() {
  return { components: componentCatalog, features: documentFeatures, schema: getComponentSchema() };
}
