import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { componentCatalog, documentFeatures } from '../components/catalog.js';
import { getComponentSchema } from '../engine/validate.js';
import { getWorkspace } from '../runtime/workspace.js';
import { listPdfComponents } from './listComponents.js';
import { validateAst } from './validateAst.js';
import { generatePdf } from './generatePdf.js';
import { mergePdfs } from './mergePdfs.js';
import { applyPdfSecurity } from './securityPdf.js';
import { getServerInfo } from './serverInfo.js';
import { listPdfs } from './listPdfs.js';
import {
  generatePdfInputSchema,
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

export function registerPdfTools(server: McpServer): void {
  server.registerTool(
    'get_pdf_server_info',
    {
      description: 'Devuelve la versión del servidor, los workspace roots detectados, la carpeta de salida por defecto, las carpetas permitidas, las fuentes instaladas, los temas disponibles y el flujo recomendado. Llamar una vez al iniciar para saber exactamente dónde se guardarán los PDFs.',
      inputSchema: serverInfoInputSchema
    },
    async () => {
      try { return ok(await getServerInfo(await getWorkspace(server))); }
      catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    'list_pdf_components',
    {
      description: 'Lista el catálogo de componentes PDF, sus categorías, propiedades requeridas/opcionales, ejemplos y esquema JSON. Consulta esta herramienta antes de construir el AST.',
      inputSchema: z.object({
        category: z.enum(['layout', 'data', 'technical', 'media', 'typography', 'all']).optional(),
        includeSchema: z.boolean().optional()
      }).strict()
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
      description: 'Valida el documento AST sin renderizar. Devuelve errores con path exacto y advertencias para autocorrección del agente. No escribe archivos.',
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
      description: 'Genera un PDF profesional a partir de un AST JSON declarativo y lo guarda en disco. Sin outputDir usa la carpeta de salida del workspace; outputDir acepta rutas relativas al workspace (p. ej. "reports/2026") o absolutas dentro de las carpetas permitidas. Devuelve path absoluto, relativePath, páginas, tamaño y warnings. No acepta HTML, CSS, JavaScript ni código ejecutable.',
      inputSchema: generatePdfInputSchema
    },
    async (input) => {
      try {
        const workspace = await getWorkspace(server);
        return ok(await renderSemaphore.run(() => generatePdf(generatePdfInputSchema.parse(input), workspace, { preParsed: true })));
      } catch (error) { return fail(error); }
    }
  );

  server.registerTool(
    'list_pdfs',
    {
      description: 'Lista los PDFs existentes en el workspace, la carpeta de salida y las carpetas permitidas, con ruta absoluta, ruta relativa, tamaño y fecha. Úsala para localizar documentos antes de merge_pdfs o apply_pdf_security en lugar de adivinar rutas.',
      inputSchema: listPdfsInputSchema
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
      description: 'Combina dos o más PDFs existentes en un documento nuevo, manteniendo el orden recibido. Acepta rutas absolutas permitidas o relativas al workspace, a la carpeta de salida o a las carpetas permitidas. Usa list_pdfs si no conoces las rutas.',
      inputSchema: mergePdfsInputSchema
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
      description: 'Actualiza metadatos y opcionalmente cifra el PDF con AES-256 y restricciones de impresión/copia. Acepta filePath absoluto permitido o relativo al workspace/output, y un outputDir opcional con las mismas reglas que generate_pdf. El cifrado requiere qpdf instalado.',
      inputSchema: securityPdfToolInputSchema
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
