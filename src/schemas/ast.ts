import { z } from 'zod';

const safeText = z.string().max(50_000);
const color = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$|^transparent$|^#[0-9a-fA-F]{8}$/);
const scalar = z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]);
const chartValue = z.number().finite().min(-1_000_000_000_000_000).max(1_000_000_000_000_000);
const common = { id: z.string().min(1).max(100).optional() };

const pageBreakNode = z.object({ type: z.literal('PageBreak'), ...common }).strict();
const viewNode: z.ZodObject<z.ZodRawShape> = z.object({
  type: z.literal('View'), ...common,
  direction: z.enum(['row', 'column']).default('column'),
  gap: z.number().min(0).max(100).default(8),
  padding: z.number().min(0).max(100).default(0),
  margin: z.number().min(0).max(100).default(0),
  backgroundColor: color.optional(),
  borderColor: color.optional(),
  borderWidth: z.number().min(0).max(10).optional(),
  borderRadius: z.number().min(0).max(40).optional(),
  wrap: z.boolean().default(true),
  align: z.enum(['flex-start', 'center', 'flex-end', 'stretch']).default('stretch'),
  justify: z.enum(['flex-start', 'center', 'flex-end', 'space-between']).default('flex-start'),
  children: z.array(z.lazy(() => componentNodeSchema)).max(300)
}).strict();
const gridNode: z.ZodObject<z.ZodRawShape> = z.object({
  type: z.literal('Grid'), ...common,
  columns: z.number().int().min(1).max(6).default(2),
  gap: z.number().min(0).max(60).default(10),
  children: z.array(z.lazy(() => componentNodeSchema)).max(100)
}).strict();
const spacerNode = z.object({ type: z.literal('Spacer'), ...common, size: z.number().min(0).max(500).default(12), axis: z.enum(['vertical', 'horizontal']).default('vertical') }).strict();
const dividerNode = z.object({ type: z.literal('Divider'), ...common, color: color.default('#D9DEE7'), thickness: z.number().min(0.25).max(8).default(1), style: z.enum(['solid', 'dashed']).default('solid'), margin: z.number().min(0).max(100).default(8) }).strict();
const documentHeaderNode = z.object({
  type: z.literal('DocumentHeader'), ...common,
  title: z.string().min(1).max(300), subtitle: z.string().max(500).optional(),
  logoUrl: z.string().max(2048).optional(), badgeText: z.string().max(80).optional(),
  alignment: z.enum(['left', 'center', 'right']).default('left')
}).strict();
const sectionTitleNode = z.object({ type: z.literal('SectionTitle'), ...common, title: z.string().min(1).max(300), number: z.union([z.string().min(1).max(20), z.number().int().min(1)]).optional(), autoNumber: z.boolean().default(false), level: z.number().int().min(1).max(3).default(1), underline: z.boolean().default(true) }).strict();
const textNode = z.object({
  type: z.literal('Text'), ...common,
  text: safeText, size: z.number().min(5).max(48).default(10),
  color: color.optional(), align: z.enum(['left', 'center', 'right', 'justify']).default('left'),
  weight: z.enum(['normal', 'semibold', 'bold']).default('normal'), italic: z.boolean().default(false),
  lineHeight: z.number().min(0.8).max(3).default(1.35), marginBottom: z.number().min(0).max(100).default(6)
}).strict();
const calloutNode = z.object({ type: z.literal('Callout'), ...common, variant: z.enum(['info', 'warning', 'success', 'danger']).default('info'), title: z.string().max(200).optional(), content: safeText, icon: z.string().max(8).optional() }).strict();
const dataTableNode = z.object({
  type: z.literal('DataTable'), ...common,
  columns: z.array(z.object({ key: z.string().min(1).max(100), label: z.string().min(1).max(100), width: z.number().min(1).max(100).optional(), align: z.enum(['left', 'center', 'right']).default('left'), format: z.enum(['text', 'currency', 'number', 'date', 'percent']).default('text') }).strict()).min(1).max(20),
  rows: z.array(z.record(z.string(), scalar)).max(3_000),
  caption: z.string().max(300).optional(), zebra: z.boolean().default(true), compact: z.boolean().default(false),
  currency: z.string().regex(/^[A-Z]{3}$/).default('PEN'), locale: z.string().min(2).max(40).default('es-PE')
}).strict();
const keyValueListNode = z.object({ type: z.literal('KeyValueList'), ...common, items: z.array(z.object({ key: z.string().min(1).max(150), value: scalar }).strict()).max(100), columns: z.union([z.literal(1), z.literal(2)]).default(2) }).strict();
const metricCardNode = z.object({ type: z.literal('MetricCard'), ...common, label: z.string().min(1).max(100), value: scalar, trend: z.string().max(30).optional(), trendColor: color.optional(), description: z.string().max(200).optional() }).strict();
const chartNode = z.object({
  type: z.literal('Chart'), ...common,
  chartType: z.enum(['bar', 'line', 'pie', 'doughnut']),
  title: z.string().max(200).optional(), labels: z.array(z.string().max(80)).min(1).max(40),
  datasets: z.array(z.object({ label: z.string().max(100), data: z.array(chartValue).min(1).max(40) }).strict()).min(1).max(6),
  showLegend: z.boolean().default(true)
}).strict();
const codeBlockNode = z.object({
  type: z.literal('CodeBlock'), ...common,
  code: z.string().max(100_000), language: z.enum(['sql', 'python', 'json', 'javascript', 'typescript', 'bash', 'yaml', 'text']).default('sql'),
  title: z.string().max(200).optional(), showLineNumbers: z.boolean().default(true),
  // 'vector' draws the gutter as SVG paths so it never lands in the copied text.
  lineNumberStyle: z.enum(['vector', 'text']).default('vector'),
  // 'fit' shrinks the font (down to a floor) before wrapping, which keeps pasted code closer to the source.
  wrap: z.enum(['fit', 'soft']).default('fit'),
  highlightLines: z.array(z.number().int().min(1).max(20_000)).max(500).optional(), theme: z.enum(['light', 'dark']).default('light')
}).strict();
const imageNode = z.object({ type: z.literal('Image'), ...common, src: z.string().min(1).max(12_000_000), width: z.number().min(10).max(1_000).optional(), height: z.number().min(10).max(1_000).optional(), fit: z.enum(['contain', 'cover', 'width']).default('contain'), caption: z.string().max(300).optional(), align: z.enum(['left', 'center', 'right']).default('center') }).strict();
const qrCodeNode = z.object({ type: z.literal('QRCode'), ...common, value: z.string().min(1).max(2_000), size: z.number().int().min(64).max(512).default(160), caption: z.string().max(200).optional() }).strict();
const signatureBlockNode = z.object({ type: z.literal('SignatureBlock'), ...common, signers: z.array(z.object({ name: z.string().min(1).max(150), role: z.string().max(150), date: z.string().max(50).optional() }).strict()).min(1).max(6) }).strict();
const invoiceSummaryNode = z.object({
  type: z.literal('InvoiceSummary'), ...common,
  currency: z.string().regex(/^[A-Z]{3}$/).default('PEN'), locale: z.string().min(2).max(40).default('es-PE'), subtotal: z.number().finite(), tax: z.number().finite().default(0), discount: z.number().finite().default(0), total: z.number().finite(), notes: z.string().max(500).optional()
}).strict();
const bulletListNode = z.object({ type: z.literal('BulletList'), ...common, items: z.array(z.string().max(2_000)).min(1).max(100), ordered: z.boolean().default(false) }).strict();
const flowchartNode = z.object({
  type: z.literal('Flowchart'), ...common,
  title: z.string().max(200).optional(),
  direction: z.enum(['vertical', 'horizontal']).default('vertical'),
  nodes: z.array(z.object({
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(160),
    description: z.string().max(240).optional(),
    kind: z.enum(['start', 'process', 'decision', 'data', 'document', 'database', 'end']).default('process'),
    color: color.optional()
  }).strict()).min(1).max(30),
  edges: z.array(z.object({
    from: z.string().min(1).max(40),
    to: z.string().min(1).max(40),
    label: z.string().max(60).optional(),
    style: z.enum(['solid', 'dashed']).default('solid')
  }).strict()).max(80).default([]),
  titleAlign: z.enum(['left', 'center', 'right']).default('center'),
  captionAlign: z.enum(['left', 'center', 'right']).default('center'),
  caption: z.string().max(300).optional()
}).strict();

export const componentNodeSchema = z.lazy(() => z.discriminatedUnion('type', [
  pageBreakNode, viewNode, gridNode, spacerNode, dividerNode, documentHeaderNode,
  sectionTitleNode, textNode, calloutNode, dataTableNode, keyValueListNode,
  metricCardNode, chartNode, codeBlockNode, imageNode, qrCodeNode,
  signatureBlockNode, invoiceSummaryNode, bulletListNode, flowchartNode
]));

export const settingsSchema = z.object({
  pageSize: z.enum(['A4', 'LETTER', 'LEGAL']).default('A4'),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  // Code blocks are rendered without a selectable gutter, but wrapped rows still break the
  // text layer. This option exports the exact sources so they can be copied verbatim.
  codeExport: z.enum(['none', 'sidecar', 'embedded', 'both']).default('none'),
  margins: z.object({ top: z.number().min(0).max(150).default(48), bottom: z.number().min(0).max(150).default(48), left: z.number().min(0).max(150).default(48), right: z.number().min(0).max(150).default(48) }).strict().default({ top: 48, bottom: 48, left: 48, right: 48 })
}).strict().default({ pageSize: 'A4', orientation: 'portrait', codeExport: 'none', margins: { top: 48, bottom: 48, left: 48, right: 48 } });

export const themeSchema = z.object({
  preset: z.enum(['corporate_blue', 'modern_minimal', 'executive_dark', 'financial_classic', 'technical_docs']).default('corporate_blue'),
  primaryColor: color.optional(), accentColor: color.optional(), mutedColor: color.optional(),
  fontFamily: z.enum(['Helvetica', 'Times-Roman', 'Courier', 'Inter', 'Roboto']).default('Inter'),
  // Optional display face for titles/KPIs. Defaults to fontFamily when omitted or unavailable.
  headingFontFamily: z.enum(['Helvetica', 'Times-Roman', 'Courier', 'Inter', 'Roboto']).optional()
}).strict().default({ preset: 'corporate_blue', fontFamily: 'Inter' });

const fixedHeaderSchema = z.object({ text: z.string().max(200).optional(), showRule: z.boolean().default(true), height: z.number().min(12).max(80).default(28) }).strict().optional();
const fixedFooterSchema = z.object({ text: z.string().max(200).optional(), showPageNumbers: z.boolean().default(true), showRule: z.boolean().default(true), height: z.number().min(12).max(80).default(28) }).strict().optional();

export const generatePdfInputSchema = z.object({
  filename: z.string().min(1).max(120).regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, 'filename solo puede contener letras, números, espacios, puntos, guiones y guiones bajos'),
  outputDir: z.string().max(500).optional(),
  overwrite: z.boolean().default(false),
  settings: settingsSchema,
  theme: themeSchema,
  metadata: z.object({ title: z.string().max(300).optional(), author: z.string().max(200).optional(), subject: z.string().max(500).optional(), keywords: z.array(z.string().max(80)).max(30).optional() }).strict().optional(),
  fixedHeader: fixedHeaderSchema,
  fixedFooter: fixedFooterSchema,
  content: z.array(componentNodeSchema).min(1).max(500)
}).strict();

// Deliberately permissive: this tool must receive malformed ASTs so it can report
// validation paths instead of having the MCP transport reject them first.
export const validatePdfAstInputSchema = z.record(z.string(), z.unknown());

export const mergePdfsInputSchema = z.object({
  filePaths: z.array(z.string().min(1).max(1_000)).min(2).max(50),
  outputFilename: z.string().min(1).max(120).regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u),
  outputDir: z.string().max(1_000).optional(),
  overwrite: z.boolean().default(false)
}).strict();

const securityPdfInputObjectSchema = z.object({
  filePath: z.string().min(1).max(1_000),
  userPassword: z.string().min(8, 'userPassword debe tener al menos 8 caracteres').max(256).optional(),
  ownerPassword: z.string().min(8, 'ownerPassword debe tener al menos 8 caracteres').max(256).optional(),
  permissions: z.object({ printing: z.boolean().default(true), copying: z.boolean().default(true) }).strict().default({ printing: true, copying: true }),
  metadata: z.object({ title: z.string().max(300).optional(), author: z.string().max(200).optional(), subject: z.string().max(500).optional(), keywords: z.array(z.string().max(80)).max(30).optional() }).strict().optional(),
  outputFilename: z.string().max(120).regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u).optional(),
  outputDir: z.string().max(1_000).optional(),
  overwrite: z.boolean().default(false)
}).strict();

export const listPdfsInputSchema = z.object({
  directory: z.string().min(1).max(1_000).optional(),
  recursive: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50)
}).strict();

export const serverInfoInputSchema = z.object({}).strict();

export const securityPdfToolInputSchema = securityPdfInputObjectSchema;
export const securityPdfInputSchema = securityPdfInputObjectSchema.superRefine((value, ctx) => {
  const wantsEncryption = Boolean(value.userPassword || value.ownerPassword || !value.permissions.printing || !value.permissions.copying);
  if (wantsEncryption && !value.ownerPassword) ctx.addIssue({ code: 'custom', path: ['ownerPassword'], message: 'ownerPassword es obligatorio cuando se aplica cifrado o restricciones de permisos' });
});

export type GeneratePdfInput = z.infer<typeof generatePdfInputSchema>;
export type MergePdfsInput = z.infer<typeof mergePdfsInputSchema>;
export type SecurityPdfInput = z.infer<typeof securityPdfInputSchema>;
export type ComponentNode = z.infer<typeof componentNodeSchema>;
