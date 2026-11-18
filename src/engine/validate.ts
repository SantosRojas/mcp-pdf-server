import { z } from 'zod';
import { componentCatalog } from '../components/catalog.js';
import { cyclicFlowchartEdges } from './flowchartLayout.js';
import { generatePdfInputSchema, type GeneratePdfInput } from '../schemas/ast.js';
import { config } from '../config.js';

export interface ValidationIssue { path: string; message: string; code?: string }

export function validatePdfAst(input: unknown): { valid: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[]; schema?: unknown } {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(input); }
  catch { return { valid: false, errors: [{ path: '$', message: 'El AST no es serializable como JSON.', code: 'INVALID_JSON_VALUE' }], warnings: [] }; }
  if (serialized === undefined) return { valid: false, errors: [{ path: '$', message: 'El AST debe ser un objeto JSON.', code: 'INVALID_JSON_VALUE' }], warnings: [] };
  if (Buffer.byteLength(serialized, 'utf8') > config.maxInputBytes) {
    return { valid: false, errors: [{ path: '$', message: `El AST supera el límite de ${config.maxInputBytes} bytes.`, code: 'INPUT_TOO_LARGE' }], warnings: [] };
  }
  // Check depth iteratively before recursive Zod validation to avoid stack exhaustion.
  const stack: Array<{ value: unknown; depth: number; path: string }> = [{ value: input, depth: 0, path: '$' }];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.depth > 30) return { valid: false, errors: [{ path: current.path, message: 'La profundidad máxima del AST es 30 niveles.', code: 'AST_DEPTH_LIMIT' }], warnings: [] };
    if (current.value && typeof current.value === 'object') {
      if (Array.isArray(current.value)) current.value.forEach((value, index) => stack.push({ value, depth: current.depth + 1, path: `${current.path}.${index}` }));
      else Object.entries(current.value).forEach(([key, value]) => stack.push({ value, depth: current.depth + 1, path: `${current.path}.${key}` }));
    }
  }
  const parsed = generatePdfInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message, code: issue.code })),
      warnings: []
    };
  }
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const walk = (nodes: unknown[], parent = 'content'): void => {
    nodes.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      const node = item as Record<string, unknown>;
      const current = `${parent}.${index}`;
      if (node.type === 'DataTable' && typeof node.locale === 'string') validateLocale(node.locale, `${current}.locale`, errors);
      if (node.type === 'DataTable' && typeof node.currency === 'string') validateCurrency(node.currency, `${current}.currency`, errors);
      if (node.type === 'InvoiceSummary') {
        if (typeof node.locale === 'string') validateLocale(node.locale, `${current}.locale`, errors);
        if (typeof node.currency === 'string') validateCurrency(node.currency, `${current}.currency`, errors);
      }
      if (node.type === 'DataTable' && Array.isArray(node.columns) && Array.isArray(node.rows)) {
        const columns = node.columns as Array<{ key: string }>;
        const keys = columns.map((column) => column.key);
        if (new Set(keys).size !== keys.length) errors.push({ path: `${current}.columns`, message: 'Cada columna debe tener un key único.' });
        (node.rows as Array<Record<string, unknown>>).forEach((row, rowIndex) => {
          columns.forEach((column) => {
            if (!(column.key in row)) warnings.push({ path: `${current}.rows.${rowIndex}.${column.key}`, message: `La fila no contiene el campo de columna '${column.key}'; se imprimirá como '-'` });
          });
        });
      }
      if (node.type === 'Chart' && Array.isArray(node.datasets) && Array.isArray(node.labels)) {
        const labels = node.labels as unknown[];
        (node.datasets as Array<{ data: number[] }>).forEach((dataset, datasetIndex) => {
          if (dataset.data.length !== labels.length) errors.push({ path: `${current}.datasets.${datasetIndex}.data`, message: 'La cantidad de datos debe coincidir con la cantidad de labels.' });
          if ((node.chartType === 'pie' || node.chartType === 'doughnut') && dataset.data.some((value) => value < 0)) errors.push({ path: `${current}.datasets.${datasetIndex}.data`, message: 'Los gráficos pie/doughnut no admiten valores negativos.' });
          if ((node.chartType === 'pie' || node.chartType === 'doughnut') && datasetIndex === 0 && !dataset.data.some((value) => value > 0)) errors.push({ path: `${current}.datasets.${datasetIndex}.data`, message: 'El dataset de un gráfico pie/doughnut debe contener al menos un valor positivo.' });
        });
      }
      if (node.type === 'Flowchart' && Array.isArray(node.nodes)) {
        const flowchartNodes = node.nodes as Array<{ id: string; label: string }>;
        const ids = flowchartNodes.map((item) => item.id);
        if (new Set(ids).size !== ids.length) errors.push({ path: `${current}.nodes`, message: 'Cada nodo del Flowchart debe tener un id único.' });
        const known = new Set(ids);
        const flowchartEdges = Array.isArray(node.edges) ? node.edges as Array<{ from: string; to: string }> : [];
        flowchartEdges.forEach((edge, edgeIndex) => {
          if (edge.from === edge.to) errors.push({ path: `${current}.edges.${edgeIndex}.to`, message: 'Un Flowchart no admite aristas de un nodo hacia sí mismo.' });
          if (!known.has(edge.from)) errors.push({ path: `${current}.edges.${edgeIndex}.from`, message: `La arista referencia un nodo inexistente: '${edge.from}'.` });
          if (!known.has(edge.to)) errors.push({ path: `${current}.edges.${edgeIndex}.to`, message: `La arista referencia un nodo inexistente: '${edge.to}'.` });
        });
        const cyclic = cyclicFlowchartEdges(flowchartNodes, flowchartEdges.map((edge) => ({ ...edge, style: 'solid' as const })));
        if (cyclic.size > 0) warnings.push({ path: `${current}.edges`, message: `El Flowchart contiene ${cyclic.size} arista(s) de retorno; se dibujan como bucles laterales en lugar de reordenar los nodos.` });
      }
      if (node.type === 'CodeBlock' && typeof node.code === 'string') {
        const lineCount = node.code.split(/\r?\n/).length;
        if (lineCount > 2_000) errors.push({ path: `${current}.code`, message: 'CodeBlock admite como máximo 2000 líneas para proteger el renderizador.' });
        if (Array.isArray(node.highlightLines)) (node.highlightLines as number[]).forEach((line) => {
          if (line > lineCount) warnings.push({ path: `${current}.highlightLines`, message: `La línea ${line} supera las ${lineCount} líneas del código.` });
        });
      }
      if (node.type === 'Image' && typeof node.src === 'string') validateImageSource(node.src, `${current}.src`, errors, warnings);
      if (node.type === 'DocumentHeader' && typeof node.logoUrl === 'string') validateImageSource(node.logoUrl, `${current}.logoUrl`, errors, warnings);
      if (Array.isArray(node.children)) walk(node.children, `${current}.children`);
    });
  };
  walk(parsed.data.content);
  return { valid: errors.length === 0, errors, warnings };
}

function validateImageSource(source: string, path: string, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  if (/^https?:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      if (url.protocol !== 'https:') errors.push({ path, message: 'Las imágenes remotas deben usar HTTPS.' });
      if (url.username || url.password) errors.push({ path, message: 'No se permiten credenciales embebidas en URLs.' });
    } catch { errors.push({ path, message: 'URL de imagen no válida.' }); }
    warnings.push({ path, message: 'La accesibilidad remota se comprueba durante generate_pdf; valide que el host sea confiable.' });
  } else if (source.startsWith('data:')) {
    if (!/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,/i.test(source)) errors.push({ path, message: 'Data URI inválido; use PNG/JPEG/WebP/SVG en Base64.' });
  } else if (source.startsWith('/') || source.split(/[\\/]/).includes('..')) {
    errors.push({ path, message: 'Use una ruta relativa dentro de PDF_MCP_ASSET_DIR; no se permiten rutas absolutas ni traversal.' });
  }
}

export function getComponentSchema(): unknown {
  return z.toJSONSchema(generatePdfInputSchema, { target: 'draft-07', io: 'input', cycles: 'ref' });
}

export function asGenerateInput(input: unknown): GeneratePdfInput {
  return generatePdfInputSchema.parse(input);
}

export function catalogForCategory(category: string | undefined): unknown {
  if (!category || category === 'all') return { components: componentCatalog, features: undefined, schema: getComponentSchema() };
  return { components: componentCatalog.filter((component) => component.category === category), schema: getComponentSchema() };
}

function validateLocale(locale: string, path: string, errors: ValidationIssue[]): void {
  try { Intl.getCanonicalLocales(locale); }
  catch { errors.push({ path, message: `Locale no válido: ${locale}. Use un identificador BCP 47, por ejemplo es-PE.` }); }
}

function validateCurrency(currency: string, path: string, errors: ValidationIssue[]): void {
  try { new Intl.NumberFormat('en-US', { style: 'currency', currency }); }
  catch { errors.push({ path, message: `Código de moneda no válido para Intl.NumberFormat: ${currency}.` }); }
}
