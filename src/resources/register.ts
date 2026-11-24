import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { serverRoot } from '../config.js';

async function readServerFile(relPath: string): Promise<string> {
  const fullPath = path.join(serverRoot, relPath);
  return fs.readFile(fullPath, 'utf8');
}

export function registerPdfResourcesAndPrompts(server: McpServer): void {
  server.registerResource(
    'agent-workflow-guide',
    'pdf://guide/workflow',
    {
      title: 'Guía de flujo y diseño PDF para agentes IA',
      description: 'Flujo recomendado, ahorro de tokens con Markdown, uso de temas, componentes profesionales y bucle de autocorrección con inspect_pdf.',
      mimeType: 'text/markdown'
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: await readServerFile('docs/LLM-AGENT-GUIDE.md')
      }]
    })
  );

  server.registerResource(
    'example-monthly-sales-report',
    'pdf://examples/monthly-sales-report',
    {
      title: 'Ejemplo AST — Reporte mensual de ventas',
      description: 'Ejemplo completo de AST JSON con KPIs, tabla formateada, gráfico y notas ejecutivas.',
      mimeType: 'application/json'
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: await readServerFile('examples/monthly-sales-report.json')
      }]
    })
  );

  server.registerResource(
    'example-invoice',
    'pdf://examples/invoice',
    {
      title: 'Ejemplo AST — Factura comercial',
      description: 'Ejemplo completo de AST JSON para factura/comprobante con KeyValueList, DataTable, InvoiceSummary y QRCode.',
      mimeType: 'application/json'
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: await readServerFile('examples/invoice-example.json')
      }]
    })
  );

  server.registerPrompt(
    'executive-report',
    {
      title: 'Generar informe ejecutivo profesional',
      description: 'Blueprint para crear un informe ejecutivo con portada, índice, KPIs con sparklines, narrativa Markdown, gráficos y revisión de layout.',
      argsSchema: {
        topic: z.string().describe('Tema u objetivo central del informe ejecutivo'),
        locale: z.string().optional().describe('Locale BCP 47 opcional, p. ej. es-PE o en-US')
      }
    },
    ({ topic, locale }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Genera un informe ejecutivo profesional en PDF sobre: "${topic}".`,
            `Sigue este flujo determinista con mcp-pdf-server:`,
            `1. Llama a get_pdf_server_info para detectar workspace y fuentes.`,
            `2. Usa settings.locale="${locale ?? 'es-PE'}", theme.preset="corporate_blue" (o "executive_dark") y fixedFooter.showPageNumbers=true.`,
            `3. Estructura recomendada del AST:`,
            `   - CoverPage (eyebrow, title, subtitle, meta con autor/fecha/clasificación).`,
            `   - TableOfContents para navegación automática.`,
            `   - Grid con 3 MetricCard (incluyendo trend y sparkline cuando haya serie histórica).`,
            `   - Nodos Markdown para las secciones analíticas extensas (ahorra tokens frente a múltiples Text/SectionTitle sueltos).`,
            `   - Chart (bar, horizontalBar, line o doughnut) y DataTable (con format="badge" para estados y footerRow para totales).`,
            `   - Timeline para hitos o próximos pasos.`,
            `4. Valida con validate_pdf_ast, genera con generate_pdf e inspecciona el resultado con inspect_pdf para corregir páginas finales casi vacías (SPARSE_TRAILING_PAGE).`
          ].join('\n')
        }
      }]
    })
  );

  server.registerPrompt(
    'technical-spec',
    {
      title: 'Generar especificación técnica / arquitectura',
      description: 'Blueprint para RFCs, diseños de arquitectura y documentación técnica con diagramas de flujo, bloques de código exportables y tablas.',
      argsSchema: {
        systemName: z.string().describe('Nombre del sistema, servicio o RFC'),
        locale: z.string().optional().describe('Locale BCP 47 opcional, p. ej. es-PE o en-US')
      }
    },
    ({ systemName, locale }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Genera una especificación técnica en PDF para "${systemName}".`,
            `Usa theme.preset="technical_docs", settings.locale="${locale ?? 'es-PE'}" y settings.codeExport="embedded" si incluyes bloques CodeBlock.`,
            `Combina CoverPage, TableOfContents, bloques Markdown (con alertas > [!WARNING] / > [!NOTE] y tablas GFM), Flowchart para arquitectura/flujos, CodeBlock (soporta typescript, go, rust, python, sql, yaml, dockerfile, etc.) y Section con orientation="landscape" si necesitas matrices anchas en anexos.`,
            `Valida con validate_pdf_ast, genera con generate_pdf y verifica paginación con inspect_pdf.`
          ].join('\n')
        }
      }]
    })
  );

  server.registerPrompt(
    'commercial-proposal',
    {
      title: 'Generar propuesta comercial / cotización',
      description: 'Blueprint para propuestas de servicios o proyectos con alcance, cronograma Timeline, inversión y bloque de firmas.',
      argsSchema: {
        clientName: z.string().describe('Nombre del cliente u organización destinataria'),
        projectScope: z.string().optional().describe('Resumen opcional del alcance o entregables')
      }
    },
    ({ clientName, projectScope }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Genera una propuesta comercial ejecutiva en PDF para el cliente "${clientName}"${projectScope ? ` (alcance: ${projectScope})` : ''}.`,
            `Incluye CoverPage, resumen ejecutivo en Markdown, alcance con BulletList (variant="check"), plan de trabajo con Timeline, desglose económico con DataTable + InvoiceSummary y cierre formal con SignatureBlock.`,
            `Ejecuta validate_pdf_ast -> generate_pdf -> inspect_pdf antes de entregar la ruta final.`
          ].join('\n')
        }
      }]
    })
  );

  server.registerPrompt(
    'invoice',
    {
      title: 'Generar factura o estado de cuenta',
      description: 'Blueprint compacto de una página para facturas, recibos u órdenes de compra con verificación aritmética.',
      argsSchema: {
        customer: z.string().describe('Cliente o razón social'),
        currency: z.string().optional().describe('Código ISO 4217 de 3 letras, p. ej. PEN, USD, EUR')
      }
    },
    ({ customer, currency }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Genera un documento de facturación/cobro en PDF para "${customer}" en moneda ${currency ?? 'PEN'}.`,
            `Usa DocumentHeader, KeyValueList (2 columnas para datos del emisor/receptor), DataTable con format="currency", InvoiceSummary verificando que subtotal + tax - discount === total, y QRCode opcional de verificación.`,
            `Valida con validate_pdf_ast (sin warnings INVOICE_TOTAL_MISMATCH), genera con generate_pdf y confirma con inspect_pdf que ocupe limpiamente las páginas previstas.`
          ].join('\n')
        }
      }]
    })
  );
}
