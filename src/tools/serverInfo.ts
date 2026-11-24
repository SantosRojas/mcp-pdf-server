import { config } from '../config.js';
import { componentCatalog } from '../components/catalog.js';
import { fontInventory, themeCatalog } from '../engine/themeProvider.js';
import { defaultWorkspace, type WorkspaceInfo } from '../runtime/workspace.js';
import { displayPath } from '../utils/paths.js';
import { probeQpdf } from '../utils/qpdf.js';

/**
 * Zero-cost discovery for agents: they learn where files will land, which fonts and
 * themes exist, and whether encryption is available before building an AST.
 */
export async function getServerInfo(workspace: WorkspaceInfo = defaultWorkspace()): Promise<Record<string, unknown>> {
  const [fonts, qpdf] = await Promise.all([fontInventory(), probeQpdf()]);
  return {
    success: true,
    server: {
      name: 'mcp-pdf-server',
      version: config.version,
      transport: config.transport,
      node: process.version,
      platform: process.platform
    },
    workspace: {
      roots: workspace.roots,
      source: workspace.source,
      primaryRoot: workspace.primaryRoot
    },
    output: {
      directory: workspace.outputDir,
      relativeToWorkspace: displayPath(workspace.primaryRoot, workspace.outputDir),
      allowedRoots: workspace.allowedRoots,
      allowAnyPath: workspace.allowAnyPath,
      pathRule: 'outputDir acepta una ruta relativa al workspace (p. ej. "reports/2026") o una ruta absoluta dentro de allowedRoots. Omitirlo usa output.directory.'
    },
    capabilities: {
      qpdf: { ...qpdf, configuredCommand: config.qpdfPath, requiredFor: ['cifrado AES-256', 'restricciones de impresión/copia'] },
      fonts,
      remoteImages: config.allowRemoteImages,
      limits: {
        maxOutputBytes: config.maxOutputBytes,
        maxInputBytes: config.maxInputBytes,
        maxConcurrentRenders: config.maxConcurrentRenders,
        maxPagesPerMerge: 2_500
      }
    },
    themes: themeCatalog,
    components: {
      count: componentCatalog.length,
      categories: ['layout', 'typography', 'data', 'technical', 'media']
    },
    tools: [
      { name: 'get_pdf_server_info', purpose: 'Descubre carpetas de salida, fuentes, temas y límites. Llamar al iniciar una sesión de trabajo.' },
      { name: 'list_pdf_components', purpose: 'Catálogo de componentes y esquema JSON del AST.' },
      { name: 'validate_pdf_ast', purpose: 'Valida el AST y devuelve rutas de error antes de renderizar.' },
      { name: 'generate_pdf', purpose: 'Genera el PDF desde el AST y devuelve path y relativePath.' },
      { name: 'list_pdfs', purpose: 'Lista PDFs existentes para localizarlos o reutilizarlos.' },
      { name: 'merge_pdfs', purpose: 'Combina PDFs existentes en un documento nuevo.' },
      { name: 'apply_pdf_security', purpose: 'Actualiza metadatos y opcionalmente cifra con qpdf.' }
    ],
    recommendedFlow: [
      '1. get_pdf_server_info (una vez por sesión) para conocer output.directory y las fuentes instaladas.',
      '2. list_pdf_components con la categoría necesaria.',
      '3. Construir el AST y validarlo con validate_pdf_ast.',
      '4. generate_pdf: guardar path/relativePath y revisar warnings.',
      '5. Usar list_pdfs + merge_pdfs / apply_pdf_security solo si el documento lo requiere.'
    ]
  };
}
