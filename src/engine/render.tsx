import React from 'react';
import {
  Document, Page, View, Link, Text as PdfText, Image as PdfImage, Svg, Rect, Line, Path, Circle, Text as SvgText,
  renderToStream
} from '@react-pdf/renderer';
import type { Readable } from 'node:stream';
import QRCode from 'qrcode';
import { PDFDocument } from 'pdf-lib';
import { renderHighlightSpans, sliceHighlightSpans, tokenizeCodeLines } from './codeHighlighter.js';
import { CodeGutter } from './codeGutter.js';
import { CODE_LINE_HEIGHT, codeGutterWidth, computeCodeMetrics, normalizeCodeLines, wrapCodeLine } from './codeMetrics.js';
import { splitInlineMarkup } from './inlineMarkup.js';
import { compileMarkdownToAst } from './markdownParser.js';
import { shouldSplitTable } from './tableLayout.js';
import { computeFlowchartLayout, flowchartMetrics, type ArrowDirection, type FlowchartKind, type PositionedFlowchartNode, type RoutedFlowchartEdge } from './flowchartLayout.js';
import { registerOptionalFonts, resolveTheme, type ThemeTokens } from './themeProvider.js';
import { LINE_HEIGHT, RADIUS, SPACE, TRACKING, TYPE, metricValueSize, mix, withAlpha } from './design.js';
import { prepareImages } from './imageProcessor.js';
import type { ComponentNode, GeneratePdfInput } from '../schemas/ast.js';
import { AppError } from '../utils/errors.js';
import { config } from '../config.js';

export interface UiStrings {
  pageOf: (page: number, total: number) => string;
  subtotal: string;
  tax: string;
  discount: string;
  total: string;
  boolYes: string;
  boolNo: string;
  missingLogo: string;
  missingImage: string;
  missingQr: string;
}

export function resolveUiStrings(locale = 'es-PE'): UiStrings {
  const isEn = locale.trim().toLowerCase().startsWith('en');
  if (isEn) {
    return {
      pageOf: (page, total) => `Page ${page} of ${total}`,
      subtotal: 'Subtotal',
      tax: 'Tax',
      discount: 'Discount',
      total: 'TOTAL',
      boolYes: 'Yes',
      boolNo: 'No',
      missingLogo: '[Logo unavailable]',
      missingImage: '[Image unavailable]',
      missingQr: '[QR unavailable]'
    };
  }
  return {
    pageOf: (page, total) => `Página ${page} de ${total}`,
    subtotal: 'Subtotal',
    tax: 'Impuestos',
    discount: 'Descuento',
    total: 'TOTAL',
    boolYes: 'Sí',
    boolNo: 'No',
    missingLogo: '[Logo no disponible]',
    missingImage: '[Imagen no disponible]',
    missingQr: '[QR no disponible]'
  };
}

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

function badgeColors(tone: BadgeTone): { bg: string; border: string; fg: string } {
  switch (tone) {
    case 'success': return { bg: '#ECFDF5', border: '#6EE7B7', fg: '#065F46' };
    case 'warning': return { bg: '#FFFBEB', border: '#FCD34D', fg: '#92400E' };
    case 'danger': return { bg: '#FEF2F2', border: '#FCA5A5', fg: '#991B1B' };
    case 'info': return { bg: '#EFF6FF', border: '#93C5FD', fg: '#1E40AF' };
    default: return { bg: '#F1F5F9', border: '#CBD5E1', fg: '#334155' };
  }
}

function inferBadgeTone(raw: string): BadgeTone {
  const key = raw.trim().toLowerCase();
  if (/^(ok|active|activo|done|completado|paid|pagado|success|aprobado|verified|healthy|ready|pass|passed|met)/.test(key)) return 'success';
  if (/^(warn|warning|pending|pendiente|riesgo|risk|review|degraded|hold|medium)/.test(key)) return 'warning';
  if (/^(err|error|fail|failed|danger|critical|critico|crítico|overdue|vencido|rejected|rechazado|blocked|bloqueado|high)/.test(key)) return 'danger';
  if (/^(info|new|nuevo|draft|borrador|in[ _-]?progress|en[ _-]?curso|open|low)/.test(key)) return 'info';
  return 'neutral';
}

export function resolveChildWidths(parentWidth: number, columns: number, gap: number, weights?: readonly number[]): number[] {
  const safeCols = Math.max(1, columns);
  const available = Math.max(60, parentWidth - gap * Math.max(0, safeCols - 1));
  const resolvedWeights = weights && weights.length === safeCols ? weights : Array<number>(safeCols).fill(1);
  const totalWeight = resolvedWeights.reduce((sum, item) => sum + item, 0) || safeCols;
  return resolvedWeights.map((weight) => (available * weight) / totalWeight);
}

export interface OutlineEntry {
  id: string;
  title: string;
  number?: string;
  level: number;
}

interface RenderContext {
  theme: ThemeTokens;
  locale: string;
  ui: UiStrings;
  images: Map<string, Buffer | null>;
  qrCodes: Map<string, Buffer | null>;
  sectionCounters: [number, number, number];
  outline: OutlineEntry[];
  contentHeight: number;
  contentWidth: number;
  warnings: string[];
}

const PAGE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  LETTER: { width: 612, height: 792 },
  LEGAL: { width: 612, height: 1008 }
};

function chartColor(palette: string[], index: number): string {
  return palette[index % palette.length] ?? palette[0] ?? '#2563EB';
}

// react-pdf's SVG typings omit fontSize on <Text>, although the layout engine reads it from props.
function svgAxisLabel(x: number, y: number, font: string) {
  return { x, y, fill: '#94A3B8', fontSize: 7.5, textAnchor: 'middle' as const, fontFamily: font };
}

function svgValueLabel(x: number, y: number, font: string) {
  return { x, y, fill: '#94A3B8', fontSize: 7, textAnchor: 'end' as const, fontFamily: font };
}

function svgFlowchartLabel(x: number, y: number, fontSize: number, fill: string, weight?: number, font?: string) {
  return { x, y, fill, fontSize, textAnchor: 'middle' as const, ...(weight ? { fontWeight: weight } : {}), ...(font ? { fontFamily: font } : {}) };
}

/** Short axis numbers: 12500 -> 12.5k, 1200000 -> 1.2M. */
function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

const NO_LIGATURES = { calt: false, liga: false, clig: false, dlig: false, rlig: false };

function textRuns(text: string, mono = 'Courier', parentSize?: number, monoColor = '#334155', linkColor = '#2563EB'): React.ReactNode[] {
  return splitInlineMarkup(text).map((run, index) => {
    if (run.kind === 'bold') return <PdfText key={index} style={{ fontWeight: 700 }}>{run.text}</PdfText>;
    // Mono faces have a larger optical size than the text face; 92% keeps the run in rhythm.
    if (run.kind === 'code') return <PdfText key={index} style={{ fontFamily: mono, fontFeatureSettings: NO_LIGATURES, color: monoColor, ...(parentSize ? { fontSize: Math.round(parentSize * 0.92 * 10) / 10 } : {}) }}>{run.text}</PdfText>;
    if (run.kind === 'italic') return <PdfText key={index} style={{ fontStyle: 'italic' }}>{run.text}</PdfText>;
    if (run.kind === 'link' && run.href) return <Link key={index} src={run.href} style={{ color: linkColor, textDecoration: 'underline' }}>{run.text}</Link>;
    return <PdfText key={index}>{run.text}</PdfText>;
  });
}

function formatNumber(value: number, locale: string, maximumFractionDigits = 2): string {
  try { return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value); }
  catch { return new Intl.NumberFormat('es-PE', { maximumFractionDigits }).format(value); }
}

function formatMoney(value: number, currency: string, locale = 'es-PE'): string {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value); }
  catch { return `${currency} ${formatNumber(value, 'es-PE')}`; }
}

export function formatCell(value: unknown, format: string, currency = 'PEN', locale = 'es-PE'): string {
  if (value === null || value === undefined) return '-';
  if (format === 'boolean') {
    if (typeof value === 'boolean') {
      const ui = resolveUiStrings(locale);
      return value ? ui.boolYes : ui.boolNo;
    }
    return String(value);
  }
  if (format === 'currency' && typeof value === 'number') return formatMoney(value, currency, locale);
  if (format === 'number' && typeof value === 'number') return formatNumber(value, locale);
  if (format === 'percent' && typeof value === 'number') return `${formatNumber(value, locale)}%`;
  if (format === 'date' && typeof value === 'string') {
    const isoDateOnly = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDateOnly) {
      const utcNoon = new Date(Date.UTC(Number(isoDateOnly[1]), Number(isoDateOnly[2]) - 1, Number(isoDateOnly[3]), 12, 0, 0));
      if (!Number.isNaN(utcNoon.getTime())) {
        try { return new Intl.DateTimeFormat(locale, { timeZone: 'UTC' }).format(utcNoon); }
        catch { return new Intl.DateTimeFormat('es-PE', { timeZone: 'UTC' }).format(utcNoon); }
      }
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    try { return new Intl.DateTimeFormat(locale).format(parsed); }
    catch { return new Intl.DateTimeFormat('es-PE').format(parsed); }
  }
  return String(value);
}

function polar(cx: number, cy: number, radius: number, angle: number): [number, number] {
  const radians = ((angle - 90) * Math.PI) / 180;
  return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)];
}

function arcPath(cx: number, cy: number, radius: number, start: number, end: number, inner = 0): string {
  const [x1, y1] = polar(cx, cy, radius, start);
  const [x2, y2] = polar(cx, cy, radius, end);
  const large = end - start > 180 ? 1 : 0;
  if (inner <= 0) return `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`;
  const [ix2, iy2] = polar(cx, cy, inner, end);
  const [ix1, iy1] = polar(cx, cy, inner, start);
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${inner} ${inner} 0 ${large} 0 ${ix1} ${iy1} Z`;
}

function truncateLabel(label: string, maxChars: number): string {
  if (label.length <= maxChars) return label;
  return `${label.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function ChartGraphic({ node, width, font, palette }: { node: any; width: number; font: string; palette: string[] }): React.ReactElement {
  const firstValues: number[] = node.datasets[0]?.data ?? [];
  const allValues: number[] = node.datasets.flatMap((dataset: { data: number[] }) => dataset.data);
  const minValue = Math.min(0, ...allValues);
  const maxValue = Math.max(0, ...allValues);
  const valueRange = Math.max(1, maxValue - minValue);
  const elements: React.ReactNode[] = [];
  let height = 230;

  if (node.chartType === 'pie' || node.chartType === 'doughnut') {
    height = 250;
    const centerX = width / 2;
    const centerY = 122;
    const radius = Math.min(94, Math.max(48, width * 0.2));
    const hole = Math.round(radius * 0.52);
    const total = firstValues.reduce((sum: number, value: number) => sum + Math.max(0, value), 0) || 1;
    let cursor = 0;
    firstValues.forEach((value: number, index: number) => {
      const sweep = Math.max(0, value) / total * 360;
      if (sweep >= 359.999) {
        elements.push(<Circle key={`slice-${index}`} cx={centerX} cy={centerY} r={radius} fill={chartColor(palette, index)} />);
        if (node.chartType === 'doughnut') elements.push(<Circle key="doughnut-hole" cx={centerX} cy={centerY} r={hole} fill="#FFFFFF" />);
      } else if (sweep > 0) {
        elements.push(<Path key={`slice-${index}`} d={arcPath(centerX, centerY, radius, cursor, cursor + sweep, node.chartType === 'doughnut' ? hole : 0)} fill={chartColor(palette, index)} />);
      }
      cursor += sweep;
    });
    if (node.chartType === 'doughnut') {
      elements.push(<SvgText key="doughnut-total" {...svgFlowchartLabel(centerX, centerY + 3.5, 10, '#334155', 700, font)}>{compactNumber(total)}</SvgText>);
    }
  } else if (node.chartType === 'horizontalBar') {
    const rowGap = 24;
    const seriesCount = Math.max(1, node.datasets.length);
    const top = 14;
    const bottom = 28;
    const chartHeight = Math.max(80, node.labels.length * rowGap);
    height = top + chartHeight + bottom;
    const left = Math.min(130, Math.max(72, Math.round(width * 0.28)));
    const right = 18;
    const chartWidth = Math.max(80, width - left - right);
    const xFor = (value: number) => left + ((value - minValue) / valueRange) * chartWidth;
    const zeroX = xFor(0);
    const ticks = 4;
    for (let tick = 0; tick <= ticks; tick += 1) {
      const value = minValue + (valueRange * tick) / ticks;
      const x = xFor(value);
      const isZero = Math.abs(value) < 1e-9;
      elements.push(<Line key={`hgrid-${tick}`} x1={x} y1={top} x2={x} y2={top + chartHeight} stroke={isZero ? '#CBD5E1' : '#E7ECF2'} strokeWidth={isZero ? 1 : 0.6} />);
      elements.push(<SvgText key={`hgrid-label-${tick}`} {...svgAxisLabel(x, top + chartHeight + 14, font)}>{compactNumber(value)}</SvgText>);
    }
    const maxLabelChars = Math.max(10, Math.floor((left - 10) / 4.3));
    node.labels.forEach((label: string, index: number) => {
      const groupTop = top + index * rowGap + rowGap * 0.16;
      const barBand = (rowGap * 0.68) / seriesCount;
      elements.push(<SvgText key={`hlabel-${index}`} {...svgValueLabel(left - 6, groupTop + (rowGap * 0.34) + 2.4, font)}>{truncateLabel(label, maxLabelChars)}</SvgText>);
      node.datasets.forEach((dataset: { data: number[] }, seriesIndex: number) => {
        const value = dataset.data[index] ?? 0;
        const xEnd = xFor(value);
        const barX = Math.min(zeroX, xEnd);
        const barW = Math.max(1, Math.abs(xEnd - zeroX));
        elements.push(<Rect key={`hbar-${seriesIndex}-${index}`} x={barX} y={groupTop + seriesIndex * barBand} width={barW} height={Math.max(3, barBand * 0.85)} fill={chartColor(palette, seriesIndex)} rx={2} />);
      });
    });
  } else {
    const isBar = node.chartType === 'bar';
    const chartHeight = isBar ? 158 : 160;
    const top = 12;
    const left = 44;
    const right = 12;
    const chartWidth = Math.max(90, width - left - right);
    const yFor = (value: number) => top + chartHeight - ((value - minValue) / valueRange) * chartHeight;
    const ticks = 4;
    for (let tick = 0; tick <= ticks; tick += 1) {
      const value = minValue + (valueRange * tick) / ticks;
      const y = yFor(value);
      const isZero = Math.abs(value) < 1e-9;
      elements.push(<Line key={`grid-${tick}`} x1={left} y1={y} x2={left + chartWidth} y2={y} stroke={isZero ? '#CBD5E1' : '#E7ECF2'} strokeWidth={isZero ? 1 : 0.6} />);
      elements.push(<SvgText key={`grid-label-${tick}`} {...svgValueLabel(left - 7, y + 2.6, font)}>{compactNumber(value)}</SvgText>);
    }
    const labelStep = Math.max(1, Math.ceil(node.labels.length / Math.max(3, Math.floor(chartWidth / 52))));
    const maxChars = Math.max(6, Math.min(18, Math.floor(((chartWidth / Math.max(1, node.labels.length)) * labelStep) / 4.4)));
    if (isBar) {
      const groupWidth = chartWidth / Math.max(1, node.labels.length);
      const seriesCount = Math.max(1, node.datasets.length);
      node.labels.forEach((label: string, index: number) => {
        node.datasets.forEach((dataset: { data: number[] }, seriesIndex: number) => {
          const value = dataset.data[index] ?? 0;
          const barHeight = Math.abs(value) / valueRange * chartHeight;
          const zeroY = yFor(0);
          const y = value >= 0 ? zeroY - barHeight : zeroY;
          const innerWidth = groupWidth * 0.72 / seriesCount;
          const x = left + index * groupWidth + groupWidth * 0.14 + seriesIndex * innerWidth;
          elements.push(<Rect key={`bar-${seriesIndex}-${index}`} x={x} y={y} width={innerWidth * 0.88} height={barHeight} fill={chartColor(palette, seriesIndex)} rx={2} />);
        });
        if (index % labelStep === 0 || index === node.labels.length - 1) {
          elements.push(<SvgText key={`label-${index}`} {...svgAxisLabel(left + index * groupWidth + groupWidth / 2, top + chartHeight + 18, font)}>{truncateLabel(label, maxChars)}</SvgText>);
        }
      });
    } else {
      node.datasets.forEach((dataset: { data: number[] }, seriesIndex: number) => {
        const points: Array<readonly [number, number]> = dataset.data.map((value: number, index: number) => {
          const x = left + (dataset.data.length <= 1 ? chartWidth / 2 : (index / (dataset.data.length - 1)) * chartWidth);
          return [x, yFor(value)] as const;
        });
        const seriesPath = points.map(([x, y]: readonly [number, number], index: number) => `${index === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ');
        const seriesColor = chartColor(palette, seriesIndex);
        elements.push(<Path key={`line-${seriesIndex}`} d={seriesPath} stroke={seriesColor} strokeWidth={2.5} fill="none" />);
        points.forEach(([x, y]: readonly [number, number], index: number) => elements.push(<Circle key={`point-${seriesIndex}-${index}`} cx={x} cy={y} r={3} fill={seriesColor} />));
      });
      node.labels.forEach((label: string, index: number) => {
        if (index % labelStep === 0 || index === node.labels.length - 1) {
          const x = left + (node.labels.length <= 1 ? chartWidth / 2 : (index / (node.labels.length - 1)) * chartWidth);
          elements.push(<SvgText key={`xlabel-${index}`} {...svgAxisLabel(x, top + chartHeight + 18, font)}>{truncateLabel(label, maxChars)}</SvgText>);
        }
      });
    }
  }
  return <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>{elements}</Svg>;
}

/**
 * Resolves the visual layout of a code block. The renderer and the pagination heuristic
 * share it, so both always agree on how many rows a block produces.
 */
function codeBlockLayout(node: any, contentWidth: number) {
  const sourceLines = normalizeCodeLines(String(node.code));
  const showLineNumbers = node.showLineNumbers !== false;
  const gutterWidth = showLineNumbers ? codeGutterWidth(sourceLines.length) : 0;
  // The card adds 5pt of horizontal padding and a 1pt border on both sides.
  const codeWidth = contentWidth - 12 - gutterWidth;
  const metrics = computeCodeMetrics(sourceLines, codeWidth, node.wrap === 'soft' ? 'soft' : 'fit');
  const rows = sourceLines.flatMap((line, index) => {
    const segments = wrapCodeLine(line, metrics.columns);
    let offset = 0;
    return segments.map((text, segment) => {
      const start = offset;
      offset += text.length;
      return { text, lineIndex: index, lineNumber: index + 1, continuation: segment > 0, start, length: text.length };
    });
  });
  return { sourceLines, showLineNumbers, gutterWidth, metrics, rows };
}

function renderCodeBlock(node: any, theme: ThemeTokens, contentWidth: number): React.ReactElement {
  const dark = node.theme === 'dark';
  const background = dark ? '#1E293B' : '#F6F8FA';
  const foreground = dark ? '#E2E8F0' : '#24292F';
  const lineNumberColor = dark ? '#94A3B8' : '#8C959F';
  const highlighted = new Set<number>(node.highlightLines ?? []);
  const { sourceLines, showLineNumbers, gutterWidth, metrics, rows } = codeBlockLayout(node, contentWidth);
  const tokenizedLines = tokenizeCodeLines(sourceLines.join('\n'), node.language, foreground, dark);
  const rowHeight = metrics.fontSize * CODE_LINE_HEIGHT;
  return (
    <View style={{ marginBottom: SPACE.lg, borderWidth: 1, borderColor: dark ? '#334155' : '#D8DEE4', borderRadius: RADIUS.md, overflow: 'hidden' }}>
      {node.title ? (
        <View style={{ backgroundColor: dark ? '#0F172A' : '#EAEFF4', borderBottomWidth: 0.5, borderBottomColor: dark ? '#334155' : '#D8DEE4', paddingHorizontal: 9, paddingVertical: 6 }}>
          <PdfText style={{ fontSize: TYPE.caption, fontWeight: 600, color: dark ? '#CBD5E1' : '#334155', fontFamily: theme.heading }}>{node.title}</PdfText>
        </View>
      ) : null}
      <View style={{ backgroundColor: background, paddingVertical: 7, paddingHorizontal: 5 }}>
        {rows.map((row, index) => {
          const lineTokens = tokenizedLines[row.lineIndex] ?? [];
          const rowTokens = sliceHighlightSpans(lineTokens, row.start, row.length);
          return (
            <View key={index} wrap={false} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 1, minHeight: rowHeight, backgroundColor: highlighted.has(row.lineNumber) ? (dark ? '#334155' : '#FFF3C4') : background }}>
              {showLineNumbers ? (node.lineNumberStyle === 'text'
                ? <PdfText style={{ width: gutterWidth, textAlign: 'right', paddingRight: 7, fontSize: metrics.fontSize, color: lineNumberColor, fontFamily: theme.mono, fontFeatureSettings: NO_LIGATURES }}>{row.continuation ? '' : row.lineNumber}</PdfText>
                : <CodeGutter lineNumber={row.lineNumber} continuation={row.continuation} width={gutterWidth} fontSize={metrics.fontSize} color={lineNumberColor} />) : null}
              <PdfText style={{ flexGrow: 1, flexShrink: 1, fontSize: metrics.fontSize, lineHeight: CODE_LINE_HEIGHT, color: foreground, fontFamily: theme.mono, fontFeatureSettings: NO_LIGATURES }}>{renderHighlightSpans(rowTokens, row.text)}</PdfText>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function flowchartShape(node: PositionedFlowchartNode, border: string, fill: string): React.ReactElement {
  const { x, y, width, height } = node;
  switch (node.kind) {
    case 'start':
    case 'end':
      return <Rect x={x} y={y} width={width} height={height} rx={height / 2} fill={fill} stroke={border} strokeWidth={1.2} />;
    case 'decision': {
      const d = `M ${x + width / 2} ${y} L ${x + width} ${y + height / 2} L ${x + width / 2} ${y + height} L ${x} ${y + height / 2} Z`;
      return <Path d={d} fill={fill} stroke={border} strokeWidth={1.2} />;
    }
    case 'data': {
      const skew = Math.min(10, width * 0.08);
      const d = `M ${x + skew} ${y} L ${x + width} ${y} L ${x + width - skew} ${y + height} L ${x} ${y + height} Z`;
      return <Path d={d} fill={fill} stroke={border} strokeWidth={1.2} />;
    }
    case 'document': {
      const wave = Math.min(7, height * 0.16);
      const d = `M ${x} ${y} L ${x + width} ${y} L ${x + width} ${y + height - wave} `
        + `C ${x + width * 0.8} ${y + height + wave * 0.6} ${x + width * 0.6} ${y + height - wave * 1.5} ${x + width * 0.4} ${y + height - wave * 0.5} `
        + `C ${x + width * 0.24} ${y + height + wave * 0.3} ${x + width * 0.1} ${y + height - wave} ${x} ${y + height - wave} Z`;
      return <Path d={d} fill={fill} stroke={border} strokeWidth={1.2} />;
    }
    case 'database': {
      const ry = Math.min(8, height * 0.18);
      const body = `M ${x} ${y + ry} Q ${x + width / 2} ${y - ry} ${x + width} ${y + ry} `
        + `L ${x + width} ${y + height - ry} Q ${x + width / 2} ${y + height + ry} ${x} ${y + height - ry} Z`;
      // The lid closes the cylinder; without it the outline reads as a lens.
      const lid = `M ${x} ${y + ry} Q ${x + width / 2} ${y + ry * 2.2} ${x + width} ${y + ry}`;
      return <React.Fragment>
        <Path d={body} fill={fill} stroke={border} strokeWidth={1.2} />
        <Path d={lid} fill="none" stroke={border} strokeWidth={1} />
      </React.Fragment>;
    }
    default:
      return <Rect x={x} y={y} width={width} height={height} rx={3} fill={fill} stroke={border} strokeWidth={1.2} />;
  }
}

function flowchartArrowHead(edge: RoutedFlowchartEdge): React.ReactElement | null {
  const end = edge.points[edge.points.length - 1];
  if (!end) return null;
  const size = 5.4;
  const spread = 4;
  const heads: Record<ArrowDirection, string> = {
    down: `M ${end.x} ${end.y} L ${end.x - spread} ${end.y - size} L ${end.x + spread} ${end.y - size} Z`,
    up: `M ${end.x} ${end.y} L ${end.x - spread} ${end.y + size} L ${end.x + spread} ${end.y + size} Z`,
    right: `M ${end.x} ${end.y} L ${end.x - size} ${end.y - spread} L ${end.x - size} ${end.y + spread} Z`,
    left: `M ${end.x} ${end.y} L ${end.x + size} ${end.y - spread} L ${end.x + size} ${end.y + spread} Z`
  };
  return <Path d={heads[edge.arrow]} fill="#64748B" />;
}

function flowchartPath(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function FlowchartGraphic({ node, context }: { node: any; context: RenderContext }): React.ReactElement {
  const layout = computeFlowchartLayout({
    nodes: node.nodes,
    edges: node.edges ?? [],
    direction: node.direction ?? 'vertical',
    width: context.contentWidth
  });
  const captionReserve = (node.title ? 18 : 0) + (node.caption ? 16 : 0) + 10;
  const budget = Math.max(180, context.contentHeight - captionReserve);
  const rawScale = Math.min(1, budget / Math.max(1, layout.height));
  const scale = Math.max(0.45, rawScale);
  if (rawScale < 0.75) {
    context.warnings.push(`El diagrama de flujo${node.title ? ` "${node.title}"` : ''} se redujo al ${Math.round(scale * 100)}% para caber en una página.`);
  }
  const elements: React.ReactNode[] = [];
  layout.edges.forEach((edge, index) => {
    elements.push(<Path key={`edge-${index}`} d={flowchartPath(edge.points)} stroke={edge.loop ? '#94A3B8' : '#64748B'} strokeWidth={1.1} fill="none" strokeDasharray={edge.style === 'dashed' ? '3 3' : 'none'} />);
    elements.push(<React.Fragment key={`arrow-${index}`}>{flowchartArrowHead(edge)}</React.Fragment>);
  });
  layout.nodes.forEach((item) => {
    const style = context.theme.flowchart[item.kind] ?? context.theme.flowchart.process!;
    const border = item.color ?? style.border;
    elements.push(<React.Fragment key={`shape-${item.id}`}>{flowchartShape(item, border, style.background)}</React.Fragment>);
    const centerX = item.x + item.width / 2;
    item.labelLines.forEach((line, lineIndex) => {
      const baseline = item.labelBaselines[lineIndex] ?? 0;
      elements.push(<SvgText key={`label-${item.id}-${lineIndex}`} {...svgFlowchartLabel(centerX, item.y + baseline, flowchartMetrics.LABEL_FONT, style.foreground, 700, context.theme.heading)}>{line}</SvgText>);
    });
    item.descriptionLines.forEach((line, lineIndex) => {
      const baseline = item.descriptionBaselines[lineIndex] ?? 0;
      elements.push(<SvgText key={`desc-${item.id}-${lineIndex}`} {...svgFlowchartLabel(centerX, item.y + baseline, flowchartMetrics.DESCRIPTION_FONT, context.theme.muted, undefined, context.theme.font)}>{line}</SvgText>);
    });
  });
  // Edge labels go last so they stay legible when they sit close to a box border.
  layout.edges.forEach((edge, index) => {
    if (!edge.label) return;
    const labelWidth = Math.min(layout.width - 4, edge.label.length * 3.4 + 7);
    const labelX = Math.max(2, Math.min(layout.width - labelWidth - 2, edge.labelX - labelWidth / 2));
    const labelY = Math.max(8, edge.labelY - 7);
    elements.push(<Rect key={`label-bg-${index}`} x={labelX} y={labelY} width={labelWidth} height={9.5} rx={2} fill="#FFFFFF" />);
    elements.push(<SvgText key={`label-text-${index}`} {...svgFlowchartLabel(labelX + labelWidth / 2, labelY + 7.4, 6.6, context.theme.muted, undefined, context.theme.font)}>{edge.label}</SvgText>);
  });
  return (
    <Svg
      width={scale === 1 ? '100%' : layout.width * scale}
      height={layout.height * scale}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
    >{elements}</Svg>
  );
}

function nextSectionNumber(counters: [number, number, number], level: number): string {
  if (level <= 1) {
    counters[0] += 1;
    counters[1] = 0;
    counters[2] = 0;
    return String(counters[0]);
  }
  if (level === 2) {
    if (counters[0] === 0) counters[0] = 1;
    counters[1] += 1;
    counters[2] = 0;
    return `${counters[0]}.${counters[1]}`;
  }
  if (counters[0] === 0) counters[0] = 1;
  if (counters[1] === 0) counters[1] = 1;
  counters[2] += 1;
  return `${counters[0]}.${counters[1]}.${counters[2]}`;
}

function estimateWrappedLines(text: string, widthPt: number, fontSize: number): number {
  const charsPerLine = Math.max(20, Math.floor(widthPt / (fontSize * 0.52)));
  return text.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
}

function SparklineGraphic({ values, width, accent }: { values: readonly number[]; width: number; accent: string }): React.ReactElement {
  const w = Math.max(60, Math.round(width));
  const h = 26;
  const pad = 3;
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;
  const points = values.map((v, i) => {
    const x = pad + (values.length <= 1 ? (w - pad * 2) / 2 : (i / (values.length - 1)) * (w - pad * 2));
    const y = pad + (h - pad * 2) - ((v - minVal) / range) * (h - pad * 2);
    return [x, y] as const;
  });
  const linePath = points.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const areaPath = `${linePath} L ${last[0].toFixed(1)} ${(h - pad).toFixed(1)} L ${first[0].toFixed(1)} ${(h - pad).toFixed(1)} Z`;
  const areaFill = mix(accent, '#FFFFFF', 0.88);
  return (
    <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ marginTop: SPACE.xs }}>
      <Path d={areaPath} fill={areaFill} />
      <Path d={linePath} stroke={accent} strokeWidth={1.6} fill="none" />
      <Circle cx={last[0]} cy={last[1]} r={2.4} fill={accent} />
    </Svg>
  );
}

function renderBulletItems(
  items: readonly any[],
  context: RenderContext,
  options: { variant?: 'bullet' | 'ordered' | 'check'; ordered?: boolean; depth: number }
): React.ReactNode {
  const t = context.theme;
  const mode = options.variant ?? (options.ordered ? 'ordered' : 'bullet');
  return items.map((rawItem: any, index: number) => {
    const isObj = typeof rawItem === 'object' && rawItem !== null;
    const text = isObj ? String(rawItem.text ?? '') : String(rawItem ?? '');
    const checked = isObj ? Boolean(rawItem.checked) : false;
    const children: any[] | undefined = isObj && Array.isArray(rawItem.children) ? rawItem.children : undefined;
    const indent = options.depth * 12;
    const itemLines = estimateWrappedLines(text, context.contentWidth - 20 - indent, TYPE.small + 0.5);
    const wrapItem = itemLines * ((TYPE.small + 0.5) * LINE_HEIGHT.relaxed) > context.contentHeight * 0.65;
    const useCheck = mode === 'check' || (isObj && typeof rawItem.checked === 'boolean');
    const marker = useCheck ? (
      <View style={{ width: 12, paddingTop: 2 }}>
        <Svg width={9} height={9} viewBox="0 0 10 10">
          <Rect x={0.8} y={0.8} width={8.4} height={8.4} rx={1.8} fill={checked ? t.accent : '#FFFFFF'} stroke={checked ? t.accent : '#94A3B8'} strokeWidth={1} />
          {checked ? <Path d="M 2.5 5.2 L 4.3 7.0 L 7.6 3.1" stroke="#FFFFFF" strokeWidth={1.4} fill="none" /> : null}
        </Svg>
      </View>
    ) : (
      <PdfText style={{ color: t.accent, fontSize: TYPE.small + 0.5, minWidth: 12, fontFamily: t.font }}>
        {mode === 'ordered' ? `${index + 1}.` : options.depth > 0 ? '◦' : '•'}
      </PdfText>
    );
    return (
      <View key={index} style={{ marginLeft: indent, marginBottom: SPACE.xs + 1 }}>
        <View wrap={wrapItem} style={{ flexDirection: 'row', gap: SPACE.md }}>
          {marker}
          <PdfText style={{ color: t.text, fontSize: TYPE.small + 0.5, flexGrow: 1, lineHeight: LINE_HEIGHT.relaxed, fontFamily: t.font }}>
            {textRuns(text, t.mono, TYPE.small + 0.5, t.primary, t.accent)}
          </PdfText>
        </View>
        {children && children.length > 0 ? (
          <View style={{ marginTop: 3 }}>
            {renderBulletItems(children, context, {
              ...(options.variant !== undefined ? { variant: options.variant } : {}),
              ...(options.ordered !== undefined ? { ordered: options.ordered } : {}),
              depth: options.depth + 1
            })}
          </View>
        ) : null}
      </View>
    );
  });
}

function renderNode(node: ComponentNode, context: RenderContext): React.ReactNode {
  const n = node as any;
  const t = context.theme;
  switch (n.type) {
    case 'PageBreak': return <View key={n.id} break />;
    case 'View': {
      const horizontalInset = (n.padding ?? 0) * 2 + (n.borderWidth ?? 0) * 2 + (n.margin ?? 0) * 2;
      const childContext: RenderContext = horizontalInset > 0
        ? { ...context, contentWidth: Math.max(60, context.contentWidth - horizontalInset) }
        : context;
      return <View key={n.id} wrap={n.wrap} style={{ flexDirection: n.direction, gap: n.gap, padding: n.padding, margin: n.margin, backgroundColor: n.backgroundColor, borderColor: n.borderColor, borderWidth: n.borderWidth, borderRadius: n.borderRadius, alignItems: n.align, justifyContent: n.justify }}>{n.children.map((child: ComponentNode, i: number) => <React.Fragment key={i}>{renderNode(child, childContext)}</React.Fragment>)}</View>;
    }
    case 'Grid': {
      const colWidths = resolveChildWidths(context.contentWidth, n.columns, n.gap, n.weights);
      const weights: number[] = n.weights && n.weights.length === n.columns ? n.weights : Array<number>(n.columns).fill(1);
      const rows: ComponentNode[][] = [];
      for (let i = 0; i < n.children.length; i += n.columns) rows.push(n.children.slice(i, i + n.columns));
      return <View key={n.id} style={{ gap: n.gap }}>
        {rows.map((row: ComponentNode[], rowIndex: number) => <View key={rowIndex} wrap={false} style={{ flexDirection: 'row', gap: n.gap }}>
          {row.map((child: ComponentNode, i: number) => <View key={i} style={{ flexGrow: weights[i] ?? 1, flexBasis: 0, minWidth: 0 }}>{renderNode(child, { ...context, contentWidth: Math.max(60, colWidths[i] ?? context.contentWidth / n.columns) })}</View>)}
          {row.length < n.columns ? Array.from({ length: n.columns - row.length }).map((_, i) => <View key={`empty-${i}`} style={{ flexGrow: weights[row.length + i] ?? 1, flexBasis: 0, minWidth: 0 }} />) : null}
        </View>)}
      </View>;
    }
    case 'Spacer': return <View key={n.id} style={n.axis === 'horizontal' ? { width: n.size } : { height: n.size }} />;
    case 'Divider': return <View key={n.id} style={{ borderTopWidth: n.thickness, borderTopColor: n.color, borderStyle: n.style, marginVertical: n.margin }} />;
    case 'DocumentHeader': {
      const logo = n.logoUrl ? context.images.get(n.logoUrl) : null;
      const centered = n.alignment === 'center';
      return <View key={n.id} wrap={false} style={{ marginBottom: SPACE.xl }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.lg, justifyContent: centered ? 'center' : 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.lg, flexGrow: 1, justifyContent: centered ? 'center' : 'flex-start' }}>
            {logo ? <PdfImage src={logo} style={{ width: 48, height: 48, objectFit: 'contain' }} /> : null}
            <View style={{ flexGrow: 1 }}>
              <PdfText style={{ fontSize: TYPE.display, fontWeight: 700, color: t.primary, fontFamily: t.heading, textAlign: n.alignment, letterSpacing: TRACKING.display, lineHeight: LINE_HEIGHT.tight }}>{n.title}</PdfText>
              {n.subtitle ? <PdfText style={{ fontSize: TYPE.small, color: t.muted, marginTop: 3, textAlign: n.alignment, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{textRuns(n.subtitle, t.mono, TYPE.small, t.primary, t.accent)}</PdfText> : null}
            </View>
          </View>
          {n.badgeText ? <View style={{ backgroundColor: t.surface, borderWidth: 0.5, borderColor: t.border, paddingHorizontal: 8, paddingVertical: 5, borderRadius: RADIUS.pill }}><PdfText style={{ color: t.primary, fontSize: TYPE.micro, fontWeight: 700, letterSpacing: TRACKING.wide, fontFamily: t.heading }}>{n.badgeText}</PdfText></View> : null}
        </View>
        <View style={{ marginTop: SPACE.md, borderBottomWidth: 1, borderBottomColor: t.border }}>
          <View style={{ width: 64, height: 2.5, backgroundColor: t.accent, borderRadius: RADIUS.sm }} />
        </View>
        {n.logoUrl && !logo ? <PdfText style={{ fontSize: TYPE.tiny, color: t.muted, marginTop: 2 }}>{context.ui.missingLogo}</PdfText> : null}
      </View>;
    }
    case 'SectionTitle': {
      const sectionNumber = n._resolvedNumber ?? (n.number ?? (n.autoNumber ? nextSectionNumber(context.sectionCounters, n.level ?? 1) : undefined));
      const size = n.level === 1 ? TYPE.h1 : n.level === 2 ? TYPE.h2 : TYPE.h3;
      const weight = n.level === 1 ? 700 : 600;
      const bookmarkLabel = sectionNumber !== undefined ? `${sectionNumber}. ${n.title}` : String(n.title);
      const anchorId = n._anchorId ?? n.id;
      return <View key={anchorId} {...(anchorId ? { id: anchorId } : {})} {...(n.bookmark !== false ? { bookmark: { title: bookmarkLabel } } : {})} wrap={false} minPresenceAhead={120} style={{ marginTop: n.level === 1 ? 14 : 9, marginBottom: 7, borderBottomWidth: n.underline ? 0.75 : 0, borderBottomColor: t.border, paddingBottom: 5 }}>
        <PdfText style={{ color: t.primary, fontSize: size, fontWeight: weight, fontFamily: t.heading, letterSpacing: TRACKING.heading, lineHeight: LINE_HEIGHT.tight }}>
          {sectionNumber !== undefined ? <PdfText style={{ color: t.accent }}>{`${sectionNumber}. `}</PdfText> : null}
          {n.title}
        </PdfText>
      </View>;
    }
    case 'Text': return <PdfText key={n.id} style={{ color: n.color ?? t.text, fontSize: n.size, textAlign: n.align, fontWeight: n.weight === 'bold' ? 700 : n.weight === 'semibold' ? 600 : 400, fontStyle: n.italic ? 'italic' : 'normal', lineHeight: n.lineHeight, marginBottom: n.marginBottom, fontFamily: t.font }}>{textRuns(n.text, t.mono, n.size, t.primary, t.accent)}</PdfText>;
    case 'Callout': {
      const c = t.callouts[(n.variant ?? 'info') as keyof typeof t.callouts] ?? t.callouts.info;
      const approxHeight = estimateWrappedLines(String(n.content), context.contentWidth - SPACE.lg * 2, TYPE.small) * (TYPE.small * LINE_HEIGHT.relaxed) + (n.title ? 20 : 0) + SPACE.lg * 2;
      const shouldWrap = approxHeight > context.contentHeight * 0.65;
      return <View key={n.id} wrap={shouldWrap} style={{ backgroundColor: c.background, borderLeftWidth: 3, borderLeftColor: c.border, padding: SPACE.lg, marginVertical: SPACE.sm, borderRadius: RADIUS.md }}>
        {n.title ? <PdfText style={{ fontSize: TYPE.small, color: c.foreground, fontWeight: 600, marginBottom: SPACE.xs, letterSpacing: TRACKING.wide, fontFamily: t.heading }}>{n.icon ? `${n.icon} ` : ''}{n.title}</PdfText> : null}
        <PdfText style={{ fontSize: TYPE.small, color: c.foreground, lineHeight: LINE_HEIGHT.relaxed, fontFamily: t.font }}>{textRuns(n.content, t.mono, TYPE.small, t.primary, t.accent)}</PdfText>
      </View>;
    }
    case 'DataTable': {
      const totalWidth = n.columns.reduce((sum: number, col: any) => sum + (col.width ?? (100 / n.columns.length)), 0);
      const widths = n.columns.map((col: any) => `${(col.width ?? (100 / n.columns.length)) / totalWidth * 100}%`);
      const rowHeight = (n.compact ? 3 : 6) * 2 + 8 * 1.25 * 2;
      const totalRows = n.rows.length + (n.footerRow ? 1 : 0);
      const estimatedHeight = (n.compact ? 5 : 7) * 2 + TYPE.caption + (n.caption ? 14 : 0) + 16 + totalRows * rowHeight;
      const fitsOnOnePage = totalRows <= 12 && estimatedHeight <= context.contentHeight;
      const splittable = shouldSplitTable(totalRows, fitsOnOnePage);
      const cellSize = n.compact ? 7 : 8;
      const header = <View fixed={splittable} style={{ flexDirection: 'row', backgroundColor: t.primary, paddingVertical: n.compact ? 5 : 7, paddingHorizontal: 6, borderTopLeftRadius: RADIUS.sm, borderTopRightRadius: RADIUS.sm }}>
        {n.columns.map((column: any, index: number) => <PdfText key={column.key} style={{ width: widths[index], color: t.onPrimary, fontSize: cellSize, fontWeight: 700, textAlign: column.align, letterSpacing: 0.25, paddingRight: 6, fontFamily: t.heading }}>{column.label}</PdfText>)}
      </View>;
      return <View key={n.id} wrap={splittable} {...(splittable ? { minPresenceAhead: 44 } : {})} style={{ marginVertical: SPACE.md }}>
        {n.caption ? <PdfText style={{ color: t.muted, fontSize: TYPE.caption, marginBottom: SPACE.xs + 1, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{n.caption}</PdfText> : null}
        {header}
        {n.rows.map((row: Record<string, unknown>, rowIndex: number) => <View key={rowIndex} wrap={false} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: n.compact ? 3 : 6, paddingHorizontal: 6, backgroundColor: n.zebra && rowIndex % 2 === 1 ? t.surface : '#FFFFFF', borderBottomWidth: 0.5, borderBottomColor: t.border }}>
          {n.columns.map((column: any, index: number) => {
            const rawVal = row[column.key];
            if (column.format === 'badge' && rawVal !== null && rawVal !== undefined && String(rawVal).trim() !== '') {
              const label = String(rawVal);
              const bc = badgeColors(inferBadgeTone(label));
              const alignItems = column.align === 'right' ? 'flex-end' : column.align === 'center' ? 'center' : 'flex-start';
              return (
                <View key={column.key} style={{ width: widths[index], alignItems, paddingRight: 6 }}>
                  <View style={{ backgroundColor: bc.bg, borderWidth: 0.5, borderColor: bc.border, borderRadius: RADIUS.pill, paddingHorizontal: 5, paddingVertical: 1 }}>
                    <PdfText style={{ color: bc.fg, fontSize: Math.max(6, cellSize - 0.5), fontWeight: 700, fontFamily: t.heading }}>{label}</PdfText>
                  </View>
                </View>
              );
            }
            const formatted = formatCell(rawVal, column.format, n.currency, n.locale);
            const contentNode = column.format === 'text' && typeof rawVal === 'string'
              ? textRuns(formatted, t.mono, cellSize, t.primary, t.accent)
              : formatted;
            return <PdfText key={column.key} style={{ width: widths[index], color: t.text, fontSize: cellSize, textAlign: column.align, lineHeight: 1.25, paddingRight: 6, fontFamily: t.font }}>{contentNode}</PdfText>;
          })}
        </View>)}
        {n.footerRow ? (
          <View wrap={false} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: n.compact ? 4 : 6.5, paddingHorizontal: 6, backgroundColor: t.surface, borderTopWidth: 1, borderTopColor: t.primary, borderBottomWidth: 0.75, borderBottomColor: t.border }}>
            {n.columns.map((column: any, index: number) => {
              const rawVal = n.footerRow[column.key];
              const display = rawVal === null || rawVal === undefined || rawVal === '' ? '' : formatCell(rawVal, column.format === 'badge' ? 'text' : column.format, n.currency, n.locale);
              return <PdfText key={column.key} style={{ width: widths[index], color: t.primary, fontSize: cellSize, fontWeight: 700, textAlign: column.align, lineHeight: 1.25, paddingRight: 6, fontFamily: t.heading }}>{display}</PdfText>;
            })}
          </View>
        ) : null}
      </View>;
    }
    case 'KeyValueList': return <View key={n.id} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.md, marginVertical: SPACE.sm }}>{n.items.map((item: any, index: number) => <View key={index} wrap={false} style={{ width: n.columns === 1 ? '100%' : '48%', paddingVertical: 5, borderBottomWidth: 0.5, borderBottomColor: t.border }}><PdfText style={{ fontSize: TYPE.micro, color: t.muted, marginBottom: 2, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{item.key}</PdfText><PdfText style={{ fontSize: TYPE.small, color: t.text, fontWeight: 600, fontFamily: t.heading }}>{typeof item.value === 'string' ? textRuns(item.value, t.mono, TYPE.small, t.primary, t.accent) : String(item.value ?? '-')}</PdfText></View>)}</View>;
    case 'MetricCard': {
      const value = String(n.value ?? '-');
      const trendColor = n.trendColor ?? '#0F8A5F';
      return <View key={n.id} wrap={false} style={{ borderWidth: 0.75, borderColor: t.border, borderTopWidth: 2.5, borderTopColor: t.accent, borderRadius: RADIUS.lg, padding: 10, backgroundColor: '#FFFFFF', marginBottom: 7 }}>
        <PdfText style={{ color: t.muted, fontSize: TYPE.caption, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{n.label}</PdfText>
        <PdfText style={{ color: t.primary, fontSize: metricValueSize(value), fontWeight: 700, marginTop: SPACE.xs, lineHeight: LINE_HEIGHT.tight, fontFamily: t.heading }}>{value}</PdfText>
        {n.trend ? <View style={{ alignSelf: 'flex-start', marginTop: SPACE.xs, backgroundColor: withAlpha(trendColor, 0.12), borderRadius: RADIUS.pill, paddingHorizontal: 5, paddingVertical: 1.5 }}><PdfText style={{ color: trendColor, fontSize: TYPE.micro, fontWeight: 600, fontFamily: t.font }}>{n.trend}</PdfText></View> : null}
        {Array.isArray(n.sparkline) && n.sparkline.length >= 2 ? <SparklineGraphic values={n.sparkline} width={Math.max(70, context.contentWidth - 22)} accent={t.accent} /> : null}
        {n.description ? <PdfText style={{ color: t.muted, fontSize: TYPE.tiny, marginTop: SPACE.xs, lineHeight: LINE_HEIGHT.normal, fontFamily: t.font }}>{n.description}</PdfText> : null}
      </View>;
    }
    case 'Chart': {
      const isRadial = n.chartType === 'pie' || n.chartType === 'doughnut';
      const firstData: number[] = n.datasets[0]?.data ?? [];
      const radialTotal = isRadial ? (firstData.reduce((sum: number, val: number) => sum + Math.max(0, val), 0) || 1) : 1;
      const legendItems = isRadial
        ? n.labels.map((label: string, idx: number) => {
            const pct = Math.round((Math.max(0, firstData[idx] ?? 0) / radialTotal) * 100);
            return { label: `${label} (${pct}%)` };
          })
        : n.datasets.map((dataset: any) => ({ label: dataset.label }));
      return <View key={n.id} wrap={false} style={{ marginVertical: SPACE.md }}>
        {n.title ? <PdfText style={{ color: t.primary, fontSize: TYPE.small + 1, fontWeight: 600, textAlign: 'center', marginBottom: SPACE.sm, letterSpacing: TRACKING.heading, fontFamily: t.heading }}>{n.title}</PdfText> : null}
        <ChartGraphic node={n} width={context.contentWidth} font={t.font} palette={t.chart} />
        {n.showLegend ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: SPACE.lg, marginTop: SPACE.xs }}>{legendItems.map((entry: { label: string }, index: number) => <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.xs }}><View style={{ width: 8, height: 8, borderRadius: RADIUS.sm, backgroundColor: chartColor(t.chart, index) }} /><PdfText style={{ fontSize: TYPE.micro, color: t.muted, fontFamily: t.font }}>{entry.label}</PdfText></View>)}</View> : null}
      </View>;
    }
    case 'CodeBlock': {
      const layout = codeBlockLayout(n, context.contentWidth);
      const estimated = Math.ceil(layout.rows.length * layout.metrics.fontSize * CODE_LINE_HEIGHT * 1.15) + (n.title ? 24 : 0) + 28;
      return <View key={n.id} wrap={estimated > context.contentHeight}>{renderCodeBlock(n, t, context.contentWidth)}</View>;
    }
    case 'Image': {
      const image = context.images.get(n.src);
      return <View key={n.id} wrap={false} style={{ alignItems: n.align === 'left' ? 'flex-start' : n.align === 'right' ? 'flex-end' : 'center', marginVertical: SPACE.sm }}>
        {image ? <PdfImage src={image} style={{ width: n.width ?? 420, maxWidth: '100%', height: n.height, objectFit: n.fit === 'width' ? 'contain' : n.fit }} /> : <PdfText style={{ color: t.muted, fontSize: TYPE.micro, padding: SPACE.lg, borderWidth: 0.5, borderColor: t.border }}>{context.ui.missingImage}</PdfText>}
        {n.caption ? <PdfText style={{ color: t.muted, fontSize: TYPE.micro, marginTop: SPACE.xs, width: '100%', textAlign: n.align, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{n.caption}</PdfText> : null}
      </View>;
    }
    case 'QRCode': {
      const qr = context.qrCodes.get(n.value);
      return <View key={n.id} wrap={false} style={{ alignItems: 'center', marginVertical: SPACE.md }}>
        {qr ? <PdfImage src={qr} style={{ width: n.size, height: n.size, maxWidth: '100%', maxHeight: '100%' }} /> : <PdfText style={{ color: t.muted, fontSize: TYPE.micro, padding: SPACE.md, borderWidth: 0.5, borderColor: t.border }}>{context.ui.missingQr}</PdfText>}
        {n.caption ? <PdfText style={{ color: t.muted, fontSize: TYPE.micro, marginTop: SPACE.xs, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{n.caption}</PdfText> : null}
      </View>;
    }
    case 'SignatureBlock': return <View key={n.id} wrap={false} style={{ flexDirection: 'row', justifyContent: 'space-around', gap: SPACE.xl, marginTop: SPACE.xxxl }}>
      {n.signers.map((signer: any, index: number) => <View key={index} style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, alignItems: 'center' }}>
        <View style={{ height: 40, width: '100%' }} /><View style={{ width: '100%', borderTopWidth: 1, borderTopColor: t.muted, marginBottom: SPACE.sm }} />
        <PdfText style={{ color: t.text, fontSize: TYPE.small, fontWeight: 600, textAlign: 'center', fontFamily: t.heading }}>{signer.name}</PdfText>
        <PdfText style={{ color: t.muted, fontSize: TYPE.micro, textAlign: 'center', fontFamily: t.font }}>{signer.role}</PdfText>
        {signer.date ? <PdfText style={{ color: t.muted, fontSize: TYPE.tiny, marginTop: 2, fontFamily: t.font }}>{signer.date}</PdfText> : null}
      </View>)}
    </View>;
    case 'InvoiceSummary': return <View key={n.id} wrap={false} style={{ alignSelf: 'flex-end', width: '58%', backgroundColor: t.surface, padding: SPACE.lg, borderRadius: RADIUS.md, marginVertical: SPACE.md }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 }}><PdfText style={{ fontSize: TYPE.caption, color: t.muted, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{context.ui.subtotal}</PdfText><PdfText style={{ fontSize: TYPE.caption + 0.5, color: t.text, fontFamily: t.font }}>{formatMoney(n.subtotal, n.currency, n.locale)}</PdfText></View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 }}><PdfText style={{ fontSize: TYPE.caption, color: t.muted, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{context.ui.tax}</PdfText><PdfText style={{ fontSize: TYPE.caption + 0.5, color: t.text, fontFamily: t.font }}>{formatMoney(n.tax, n.currency, n.locale)}</PdfText></View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 }}><PdfText style={{ fontSize: TYPE.caption, color: t.muted, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{context.ui.discount}</PdfText><PdfText style={{ fontSize: TYPE.caption + 0.5, color: t.text, fontFamily: t.font }}>-{formatMoney(n.discount, n.currency, n.locale)}</PdfText></View>
      <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: SPACE.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}><PdfText style={{ fontSize: TYPE.small, color: t.primary, fontWeight: 700, letterSpacing: TRACKING.caps, fontFamily: t.heading }}>{context.ui.total}</PdfText><PdfText style={{ fontSize: TYPE.h2, color: t.primary, fontWeight: 700, fontFamily: t.heading }}>{formatMoney(n.total, n.currency, n.locale)}</PdfText></View>
      {n.notes ? <PdfText style={{ fontSize: TYPE.tiny, color: t.muted, marginTop: SPACE.sm, fontFamily: t.font }}>{textRuns(n.notes, t.mono, TYPE.tiny, t.primary, t.accent)}</PdfText> : null}
    </View>;
    case 'BulletList': return <View key={n.id} style={{ marginVertical: SPACE.sm }}>{renderBulletItems(n.items, context, { variant: n.variant, ordered: n.ordered, depth: 0 })}</View>;
    case 'Badge': {
      const bc = badgeColors((n.tone ?? 'neutral') as BadgeTone);
      const alignSelf = n.align === 'right' ? 'flex-end' : n.align === 'center' ? 'center' : 'flex-start';
      return (
        <View key={n.id} wrap={false} style={{ alignSelf, backgroundColor: bc.bg, borderWidth: 0.75, borderColor: bc.border, borderRadius: RADIUS.pill, paddingHorizontal: 7, paddingVertical: 2.5, marginVertical: SPACE.xs }}>
          <PdfText style={{ color: bc.fg, fontSize: TYPE.micro, fontWeight: 700, letterSpacing: TRACKING.wide, fontFamily: t.heading }}>{n.text}</PdfText>
        </View>
      );
    }
    case 'Timeline': return (
      <View key={n.id} style={{ marginVertical: SPACE.md }}>
        {n.title ? <PdfText style={{ color: t.primary, fontSize: TYPE.small + 0.5, fontWeight: 600, marginBottom: SPACE.sm, letterSpacing: TRACKING.heading, fontFamily: t.heading }}>{n.title}</PdfText> : null}
        {n.items.map((item: any, index: number) => {
          const isLast = index === n.items.length - 1;
          const status = item.status ?? 'done';
          const markerColor = status === 'done' ? t.accent : status === 'active' ? t.primary : '#CBD5E1';
          return (
            <View key={index} wrap={false} style={{ flexDirection: 'row', gap: SPACE.md }}>
              <View style={{ width: 16, alignItems: 'center' }}>
                <Svg width={12} height={12} viewBox="0 0 12 12">
                  {status === 'done' ? (
                    <React.Fragment>
                      <Circle cx={6} cy={6} r={5} fill={markerColor} />
                      <Path d="M 3.6 6.1 L 5.2 7.7 L 8.5 4.2" stroke="#FFFFFF" strokeWidth={1.3} fill="none" />
                    </React.Fragment>
                  ) : status === 'active' ? (
                    <React.Fragment>
                      <Circle cx={6} cy={6} r={5} fill="#FFFFFF" stroke={markerColor} strokeWidth={1.5} />
                      <Circle cx={6} cy={6} r={2.3} fill={markerColor} />
                    </React.Fragment>
                  ) : (
                    <Circle cx={6} cy={6} r={4.5} fill="#FFFFFF" stroke={markerColor} strokeWidth={1.2} />
                  )}
                </Svg>
                {!isLast ? <View style={{ width: 1.2, flexGrow: 1, minHeight: 14, backgroundColor: '#E2E8F0', marginVertical: 2 }} /> : null}
              </View>
              <View style={{ flexGrow: 1, flexShrink: 1, paddingBottom: isLast ? 2 : SPACE.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                  <PdfText style={{ color: t.text, fontSize: TYPE.small, fontWeight: 700, fontFamily: t.heading }}>{item.title}</PdfText>
                  {item.date ? <View style={{ backgroundColor: t.surface, borderRadius: RADIUS.pill, paddingHorizontal: 5, paddingVertical: 1 }}><PdfText style={{ color: t.muted, fontSize: TYPE.tiny, fontFamily: t.font }}>{item.date}</PdfText></View> : null}
                </View>
                {item.description ? <PdfText style={{ color: t.muted, fontSize: TYPE.caption + 0.5, marginTop: 2, lineHeight: LINE_HEIGHT.normal, fontFamily: t.font }}>{textRuns(item.description, t.mono, TYPE.caption + 0.5, t.primary, t.accent)}</PdfText> : null}
              </View>
            </View>
          );
        })}
      </View>
    );
    case 'Quote': return (
      <View key={n.id} wrap={false} style={{ backgroundColor: t.surface, borderLeftWidth: 3, borderLeftColor: t.accent, paddingVertical: SPACE.md, paddingHorizontal: SPACE.lg, marginVertical: SPACE.sm, borderRadius: RADIUS.sm }}>
        <PdfText style={{ color: t.text, fontSize: TYPE.small + 0.5, fontStyle: 'italic', lineHeight: LINE_HEIGHT.relaxed, fontFamily: t.font }}>{textRuns(n.text, t.mono, TYPE.small + 0.5, t.primary, t.accent)}</PdfText>
        {n.author || n.role ? (
          <PdfText style={{ color: t.muted, fontSize: TYPE.caption, marginTop: SPACE.xs + 1, fontWeight: 600, fontFamily: t.heading }}>
            {`— ${[n.author, n.role].filter(Boolean).join(', ')}`}
          </PdfText>
        ) : null}
      </View>
    );
    case 'TableOfContents': {
      const maxLevel = n.maxLevel ?? 3;
      const items = context.outline.filter((entry) => entry.level <= maxLevel);
      const defaultTitle = context.locale.toLowerCase().startsWith('en') ? 'Table of Contents' : 'Índice de Contenidos';
      return (
        <View key={n.id} style={{ marginVertical: SPACE.lg, padding: SPACE.lg, backgroundColor: t.surface, borderRadius: RADIUS.md, borderWidth: 0.5, borderColor: t.border }}>
          <PdfText style={{ color: t.primary, fontSize: TYPE.h2, fontWeight: 700, marginBottom: SPACE.md, letterSpacing: TRACKING.heading, fontFamily: t.heading }}>{n.title ?? defaultTitle}</PdfText>
          {items.map((entry, idx) => {
            const indent = (entry.level - 1) * 14;
            const labelText = entry.number !== undefined ? `${entry.number}. ${entry.title}` : entry.title;
            return (
              <View key={idx} wrap={false} style={{ flexDirection: 'row', alignItems: 'center', marginLeft: indent, paddingVertical: 3, borderBottomWidth: 0.4, borderBottomColor: t.border }}>
                <Link src={`#${entry.id}`} style={{ color: entry.level === 1 ? t.primary : t.text, textDecoration: 'none', fontSize: entry.level === 1 ? TYPE.small : TYPE.caption + 0.5, fontWeight: entry.level === 1 ? 700 : 400, fontFamily: entry.level === 1 ? t.heading : t.font }}>
                  {labelText}
                </Link>
              </View>
            );
          })}
        </View>
      );
    }
    case 'Markdown': {
      const compiled = compileMarkdownToAst(String(n.markdown));
      return <View key={n.id}>{compiled.map((child, idx) => <React.Fragment key={idx}>{renderNode(child, context)}</React.Fragment>)}</View>;
    }
    case 'Flowchart': return <View key={n.id} wrap={false} style={{ marginVertical: SPACE.md }}>
      {n.title ? <PdfText style={{ fontSize: TYPE.small + 0.5, fontWeight: 600, color: t.primary, marginBottom: SPACE.sm, textAlign: n.titleAlign, letterSpacing: TRACKING.heading, fontFamily: t.heading }}>{n.title}</PdfText> : null}
      <View style={{ alignItems: 'center' }}><FlowchartGraphic node={n} context={context} /></View>
      {n.caption ? <PdfText style={{ fontSize: TYPE.micro, color: t.muted, marginTop: SPACE.xs + 1, textAlign: n.captionAlign, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{n.caption}</PdfText> : null}
    </View>;
    default: throw new AppError(`Componente no implementado: ${String(n.type)}`, 'UNSUPPORTED_COMPONENT', `content.${n.id ?? 'unknown'}`);
  }
}

function renderCoverPage(node: any, context: RenderContext, pageSize: any, orientation: any, pageMargins: { top: number; bottom: number; left: number; right: number }): React.ReactElement {
  const t = context.theme;
  const logo = node.logoUrl ? context.images.get(node.logoUrl) : null;
  return (
    <Page size={pageSize} orientation={orientation} style={{ paddingTop: pageMargins.top + 18, paddingBottom: pageMargins.bottom, paddingLeft: pageMargins.left, paddingRight: pageMargins.right, fontFamily: t.font, color: t.text, justifyContent: 'space-between' }}>
      <View>
        <View style={{ width: 72, height: 4, backgroundColor: t.accent, borderRadius: RADIUS.sm, marginBottom: SPACE.xxl }} />
        {logo ? <PdfImage src={logo} style={{ width: 64, height: 64, objectFit: 'contain', marginBottom: SPACE.xl }} /> : null}
        {node.eyebrow ? (
          <View style={{ alignSelf: 'flex-start', backgroundColor: t.surface, borderWidth: 0.75, borderColor: t.border, borderRadius: RADIUS.pill, paddingHorizontal: 10, paddingVertical: 4, marginBottom: SPACE.lg }}>
            <PdfText style={{ color: t.accent, fontSize: TYPE.caption, fontWeight: 700, letterSpacing: TRACKING.caps, fontFamily: t.heading }}>{node.eyebrow}</PdfText>
          </View>
        ) : null}
        <PdfText style={{ color: t.primary, fontSize: 28, fontWeight: 700, lineHeight: 1.15, letterSpacing: TRACKING.display, fontFamily: t.heading }}>{node.title}</PdfText>
        {node.subtitle ? (
          <PdfText style={{ color: t.muted, fontSize: 13, lineHeight: 1.45, marginTop: SPACE.lg, fontFamily: t.font }}>{textRuns(node.subtitle, t.mono, 13, t.primary, t.accent)}</PdfText>
        ) : null}
      </View>
      <View>
        {Array.isArray(node.meta) && node.meta.length > 0 ? (
          <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: SPACE.lg, flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xl }}>
            {node.meta.map((item: { label: string; value: string }, idx: number) => (
              <View key={idx} style={{ minWidth: 140, marginBottom: SPACE.sm }}>
                <PdfText style={{ color: t.muted, fontSize: TYPE.micro, letterSpacing: TRACKING.caps, marginBottom: 2, fontFamily: t.font }}>{item.label}</PdfText>
                <PdfText style={{ color: t.text, fontSize: TYPE.small + 0.5, fontWeight: 600, fontFamily: t.heading }}>{item.value}</PdfText>
              </View>
            ))}
          </View>
        ) : null}
        {node.footerNote ? (
          <PdfText style={{ color: t.muted, fontSize: TYPE.caption, marginTop: SPACE.lg, fontFamily: t.font }}>{node.footerNote}</PdfText>
        ) : null}
      </View>
    </Page>
  );
}

function expandAndIndexContent(nodes: readonly ComponentNode[]): { expanded: any[]; outline: OutlineEntry[] } {
  const counters: [number, number, number] = [0, 0, 0];
  const outline: OutlineEntry[] = [];
  let anchorSeq = 0;

  const transformList = (items: readonly any[]): any[] => {
    const out: any[] = [];
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      if (raw.type === 'Markdown' && typeof raw.markdown === 'string') {
        out.push(...transformList(compileMarkdownToAst(raw.markdown)));
        continue;
      }
      if (raw.type === 'SectionTitle') {
        anchorSeq += 1;
        const anchorId = raw.id ?? `sec-${anchorSeq}`;
        const resolvedNum = raw.number !== undefined
          ? String(raw.number)
          : raw.autoNumber
            ? nextSectionNumber(counters, raw.level ?? 1)
            : undefined;
        outline.push({
          id: anchorId,
          title: String(raw.title),
          ...(resolvedNum !== undefined ? { number: resolvedNum } : {}),
          level: raw.level ?? 1
        });
        out.push({ ...raw, _anchorId: anchorId, ...(resolvedNum !== undefined ? { _resolvedNumber: resolvedNum } : {}) });
        continue;
      }
      if (Array.isArray(raw.children)) {
        out.push({ ...raw, children: transformList(raw.children) });
        continue;
      }
      out.push(raw);
    }
    return out;
  };

  return { expanded: transformList(nodes), outline };
}

async function prepareQrCodes(nodes: unknown[]): Promise<{ codes: Map<string, Buffer | null>; warnings: string[] }> {
  const values = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    if (record.type === 'QRCode' && typeof record.value === 'string') values.add(record.value);
    Object.values(record).forEach(visit);
  };
  visit(nodes);
  if (values.size > 100) throw new AppError('Un documento puede incluir como máximo 100 códigos QR únicos.', 'QR_COUNT_LIMIT');
  const codes = new Map<string, Buffer | null>();
  const warnings: string[] = [];
  const entries = [...values];
  for (let index = 0; index < entries.length; index += 10) {
    await Promise.all(entries.slice(index, index + 10).map(async (value) => {
      try { codes.set(value, await QRCode.toBuffer(value, { type: 'png', width: 512, margin: 1, errorCorrectionLevel: 'M' })); }
      catch (error) {
        codes.set(value, null);
        warnings.push(`No se pudo generar un QR (${value.slice(0, 80)}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }
  return { codes, warnings };
}

export interface RenderOptions {
  attachment?: {
    name: string;
    content: Buffer;
    mimeType?: string;
    description?: string;
  };
}

export interface RenderResult { bytes: Buffer; pageCount: number; warnings: string[]; outline: OutlineEntry[] }

export async function renderPdf(input: GeneratePdfInput, options?: RenderOptions): Promise<RenderResult> {
  await registerOptionalFonts();
  const { theme, warnings: fontWarnings } = resolveTheme(input.theme);
  const { expanded, outline } = expandAndIndexContent(input.content);
  const [{ images, warnings }, { codes: qrCodes, warnings: qrWarnings }] = await Promise.all([prepareImages(expanded), prepareQrCodes(expanded)]);
  warnings.push(...fontWarnings, ...qrWarnings);
  const docLocale = input.settings.locale ?? 'es-PE';
  const ui = resolveUiStrings(docLocale);
  const pageMargins = input.settings.margins;
  const chromeOffset = 18;
  const chromeGap = 12;
  const paddingTop = input.fixedHeader
    ? Math.max(pageMargins.top, chromeOffset + input.fixedHeader.height + chromeGap)
    : pageMargins.top;
  const paddingBottom = input.fixedFooter
    ? Math.max(pageMargins.bottom, chromeOffset + input.fixedFooter.height + chromeGap)
    : pageMargins.bottom;

  const baseContext: RenderContext = {
    theme,
    locale: docLocale,
    ui,
    images,
    qrCodes,
    sectionCounters: [0, 0, 0],
    outline,
    contentHeight: 0,
    contentWidth: 0,
    warnings
  };

  type PageSegment =
    | { kind: 'cover'; node: any }
    | { kind: 'body'; pageSize: any; orientation: 'portrait' | 'landscape'; nodes: any[] };

  const segments: PageSegment[] = [];
  for (const item of expanded) {
    if (item.type === 'CoverPage') {
      segments.push({ kind: 'cover', node: item });
    } else if (item.type === 'Section') {
      segments.push({
        kind: 'body',
        pageSize: item.pageSize ?? input.settings.pageSize,
        orientation: item.orientation ?? input.settings.orientation,
        nodes: item.children ?? []
      });
    } else {
      const last = segments[segments.length - 1];
      if (last && last.kind === 'body' && last.pageSize === input.settings.pageSize && last.orientation === input.settings.orientation) {
        last.nodes.push(item);
      } else {
        segments.push({
          kind: 'body',
          pageSize: input.settings.pageSize,
          orientation: input.settings.orientation,
          nodes: [item]
        });
      }
    }
  }

  const watermarkColor = input.settings.watermark
    ? mix(theme.primary, '#FFFFFF', 1 - Math.min(0.3, Math.max(0.02, input.settings.watermark.opacity ?? 0.07)))
    : undefined;

  const pageElements = segments.map((seg, segIndex) => {
    if (seg.kind === 'cover') {
      return <React.Fragment key={`seg-${segIndex}`}>{renderCoverPage(seg.node, baseContext, input.settings.pageSize, input.settings.orientation, pageMargins)}</React.Fragment>;
    }
    const dims = PAGE_DIMENSIONS[seg.pageSize] ?? PAGE_DIMENSIONS.A4!;
    const pHeight = seg.orientation === 'landscape' ? dims.width : dims.height;
    const pWidth = seg.orientation === 'landscape' ? dims.height : dims.width;
    const segContext: RenderContext = {
      ...baseContext,
      contentHeight: Math.max(120, pHeight - paddingTop - paddingBottom - 12),
      contentWidth: Math.max(160, pWidth - pageMargins.left - pageMargins.right)
    };
    const segContent = seg.nodes.map((node: ComponentNode, idx: number) => <React.Fragment key={idx}>{renderNode(node, segContext)}</React.Fragment>);

    return (
      <Page key={`seg-${segIndex}`} size={seg.pageSize} orientation={seg.orientation} style={{ paddingTop, paddingBottom, paddingLeft: pageMargins.left, paddingRight: pageMargins.right, fontFamily: theme.font, fontSize: 9, color: theme.text }}>
        {input.settings.watermark && watermarkColor ? (
          <View fixed style={{ position: 'absolute', top: pHeight * 0.44, left: 0, width: pWidth, alignItems: 'center' }}>
            <PdfText style={{ color: watermarkColor, fontSize: 54, fontWeight: 700, letterSpacing: 4, fontFamily: theme.heading, transform: 'rotate(-35deg)' }}>
              {input.settings.watermark.text}
            </PdfText>
          </View>
        ) : null}
        {input.fixedHeader ? (
          <View fixed style={{ position: 'absolute', top: chromeOffset, left: pageMargins.left, right: pageMargins.right, height: input.fixedHeader.height, justifyContent: 'center' }}>
            <PdfText
              style={{ color: theme.muted, fontSize: TYPE.micro, textAlign: input.fixedHeader.align ?? 'left', letterSpacing: TRACKING.wide, fontFamily: theme.font }}
              render={({ pageNumber, totalPages }) => {
                if (input.fixedHeader?.skipFirstPage && pageNumber === 1) return '';
                return (input.fixedHeader?.text ?? input.metadata?.title ?? input.filename)
                  .replaceAll('{{pageNumber}}', String(pageNumber))
                  .replaceAll('{{totalPages}}', String(totalPages));
              }}
            />
            {input.fixedHeader.showRule ? (
              <View render={({ pageNumber }) => (input.fixedHeader?.skipFirstPage && pageNumber === 1 ? null : <View style={{ marginTop: 4, borderBottomWidth: 0.6, borderBottomColor: theme.border }} />)} />
            ) : null}
          </View>
        ) : null}
        {segContent}
        {input.fixedFooter ? (
          <View fixed style={{ position: 'absolute', bottom: chromeOffset, left: pageMargins.left, right: pageMargins.right, height: input.fixedFooter.height, justifyContent: 'center' }}>
            {input.fixedFooter.showRule ? (
              <View render={({ pageNumber }) => (input.fixedFooter?.skipFirstPage && pageNumber === 1 ? null : <View style={{ marginBottom: 4, borderTopWidth: 0.6, borderTopColor: theme.border }} />)} />
            ) : null}
            <PdfText
              style={{ color: theme.muted, fontSize: TYPE.tiny, textAlign: input.fixedFooter.align ?? 'center', letterSpacing: TRACKING.wide, fontFamily: theme.font }}
              render={({ pageNumber, totalPages }) => {
                if (input.fixedFooter?.skipFirstPage && pageNumber === 1) return '';
                const prefix = input.fixedFooter?.text
                  ? `${input.fixedFooter.text.replaceAll('{{pageNumber}}', String(pageNumber)).replaceAll('{{totalPages}}', String(totalPages))}   `
                  : '';
                const pageLabel = input.fixedFooter?.showPageNumbers === false ? '' : ui.pageOf(pageNumber, totalPages);
                return `${prefix}${pageLabel}`;
              }}
            />
          </View>
        ) : null}
      </Page>
    );
  });

  const doc = (
    <Document
      title={input.metadata?.title ?? input.filename}
      author={input.metadata?.author ?? 'MCP PDF Server'}
      {...(input.metadata?.subject ? { subject: input.metadata.subject } : {})}
      {...(input.metadata?.keywords?.length ? { keywords: input.metadata.keywords.join(', ') } : {})}
      {...(outline.length > 0 ? { pageMode: 'useOutlines' as const } : {})}
      creator="mcp-pdf-server"
      producer="mcp-pdf-server / @react-pdf/renderer"
    >
      {pageElements}
    </Document>
  );

  const stream = await renderToStream(doc) as Readable;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let completed = false;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > config.maxOutputBytes) {
        throw new AppError(`El PDF supera el límite de salida de ${config.maxOutputBytes} bytes durante el renderizado.`, 'OUTPUT_TOO_LARGE');
      }
      chunks.push(buffer);
    }
    completed = true;
  } finally {
    if (!completed && !stream.destroyed) stream.destroy();
  }
  let bytes: Buffer = Buffer.concat(chunks, totalBytes);
  if (bytes.byteLength === 0) throw new AppError('El motor PDF devolvió un archivo vacío.', 'RENDER_EMPTY_OUTPUT');
  const parsed = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const pageCount = parsed.getPageCount();
  if (options?.attachment) {
    const now = new Date();
    await parsed.attach(options.attachment.content, options.attachment.name, {
      mimeType: options.attachment.mimeType ?? 'text/markdown',
      description: options.attachment.description ?? 'Companion attachment',
      creationDate: now,
      modificationDate: now
    });
    bytes = Buffer.from(await parsed.save());
  }
  return { bytes, pageCount, warnings, outline };
}
