import React from 'react';
import {
  Document, Page, View, Text as PdfText, Image as PdfImage, Svg, Rect, Line, Path, Circle, Text as SvgText,
  renderToStream
} from '@react-pdf/renderer';
import type { Readable } from 'node:stream';
import QRCode from 'qrcode';
import { PDFDocument } from 'pdf-lib';
import { renderHighlightedLine } from './codeHighlighter.js';
import { CodeGutter } from './codeGutter.js';
import { CODE_LINE_HEIGHT, codeGutterWidth, computeCodeMetrics, normalizeCodeLines, wrapCodeLine } from './codeMetrics.js';
import { splitInlineMarkup } from './inlineMarkup.js';
import { computeFlowchartLayout, flowchartMetrics, type ArrowDirection, type FlowchartKind, type PositionedFlowchartNode, type RoutedFlowchartEdge } from './flowchartLayout.js';
import { registerOptionalFonts, resolveTheme, type ThemeTokens } from './themeProvider.js';
import { prepareImages } from './imageProcessor.js';
import type { ComponentNode, GeneratePdfInput } from '../schemas/ast.js';
import { AppError } from '../utils/errors.js';
import { config } from '../config.js';

interface RenderContext {
  theme: ThemeTokens;
  images: Map<string, Buffer | null>;
  qrCodes: Map<string, Buffer | null>;
  sectionCounter: number;
  contentHeight: number;
  contentWidth: number;
  warnings: string[];
}

const chartPalette = ['#2563EB', '#0F9D79', '#E59B22', '#8B5CF6', '#D14C67', '#0EA5E9'] as const;

const PAGE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  LETTER: { width: 612, height: 792 },
  LEGAL: { width: 612, height: 1008 }
};

function chartColor(index: number): string {
  return chartPalette[index % chartPalette.length] ?? chartPalette[0];
}

// react-pdf's SVG typings omit fontSize on <Text>, although the layout engine reads it from props.
function svgAxisLabel(x: number, y: number, font: string) {
  return { x, y, fill: '#64748B', fontSize: 8.5, textAnchor: 'middle' as const, fontFamily: font };
}

function svgFlowchartLabel(x: number, y: number, fontSize: number, fill: string, weight?: number, font?: string) {
  return { x, y, fill, fontSize, textAnchor: 'middle' as const, ...(weight ? { fontWeight: weight } : {}), ...(font ? { fontFamily: font } : {}) };
}

function textRuns(text: string, mono = 'Courier', parentSize?: number): React.ReactNode[] {
  return splitInlineMarkup(text).map((run, index) => {
    if (run.kind === 'bold') return <PdfText key={index} style={{ fontWeight: 700 }}>{run.text}</PdfText>;
    // Mono faces have a larger optical size than the text face; 92% keeps the run in rhythm.
    if (run.kind === 'code') return <PdfText key={index} style={{ fontFamily: mono, color: '#334155', ...(parentSize ? { fontSize: Math.round(parentSize * 0.92 * 10) / 10 } : {}) }}>{run.text}</PdfText>;
    if (run.kind === 'italic') return <PdfText key={index} style={{ fontStyle: 'italic' }}>{run.text}</PdfText>;
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

function formatCell(value: unknown, format: string, currency = 'PEN', locale = 'es-PE'): string {
  if (value === null || value === undefined) return '-';
  if (format === 'currency' && typeof value === 'number') return formatMoney(value, currency, locale);
  if (format === 'number' && typeof value === 'number') return formatNumber(value, locale);
  if (format === 'percent' && typeof value === 'number') return `${formatNumber(value, locale)}%`;
  if (format === 'date' && typeof value === 'string') {
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

function ChartGraphic({ node, width, font }: { node: any; width: number; font: string }): React.ReactElement {
  const height = node.chartType === 'pie' || node.chartType === 'doughnut' ? 250 : 230;
  const firstValues: number[] = node.datasets[0]?.data ?? [];
  const allValues: number[] = node.datasets.flatMap((dataset: { data: number[] }) => dataset.data);
  const minValue = Math.min(0, ...allValues);
  const maxValue = Math.max(0, ...allValues);
  const valueRange = Math.max(1, maxValue - minValue);
  const elements: React.ReactNode[] = [];
  if (node.chartType === 'pie' || node.chartType === 'doughnut') {
    // Centre the circle in the actual content width: the previous fixed cx=160 left
    // the chart hugging the left edge of the page.
    const centerX = width / 2;
    const centerY = 122;
    const radius = Math.min(94, Math.max(56, width * 0.2));
    const hole = Math.round(radius * 0.51);
    const total = firstValues.reduce((sum: number, value: number) => sum + Math.max(0, value), 0) || 1;
    let cursor = 0;
    firstValues.forEach((value: number, index: number) => {
      const sweep = Math.max(0, value) / total * 360;
      if (sweep >= 359.999) {
        elements.push(<Circle key={`slice-${index}`} cx={centerX} cy={centerY} r={radius} fill={chartColor(index)} />);
        if (node.chartType === 'doughnut') elements.push(<Circle key="doughnut-hole" cx={centerX} cy={centerY} r={hole} fill="#FFFFFF" />);
      } else if (sweep > 0) {
        elements.push(<Path key={`slice-${index}`} d={arcPath(centerX, centerY, radius, cursor, cursor + sweep, node.chartType === 'doughnut' ? hole : 0)} fill={chartColor(index)} />);
      }
      cursor += sweep;
    });
  } else if (node.chartType === 'bar') {
    const chartHeight = 155; const top = 14; const left = 26; const right = 10;
    const chartWidth = Math.max(120, width - left - right);
    const groupWidth = chartWidth / Math.max(1, node.labels.length);
    const seriesCount = Math.max(1, node.datasets.length);
    node.labels.forEach((label: string, index: number) => {
      node.datasets.forEach((dataset: { data: number[] }, seriesIndex: number) => {
        const value = dataset.data[index] ?? 0;
        const barHeight = Math.abs(value) / valueRange * chartHeight;
        const zeroY = top + chartHeight - ((0 - minValue) / valueRange) * chartHeight;
        const y = value >= 0 ? zeroY - barHeight : zeroY;
        const innerWidth = groupWidth * 0.72 / seriesCount;
        const x = left + index * groupWidth + groupWidth * 0.14 + seriesIndex * innerWidth;
        elements.push(<Rect key={`bar-${seriesIndex}-${index}`} x={x} y={y} width={innerWidth * 0.88} height={barHeight} fill={chartColor(seriesIndex)} rx={2} />);
      });
      elements.push(<SvgText key={`label-${index}`} {...svgAxisLabel(left + index * groupWidth + groupWidth / 2, top + chartHeight + 18, font)}>{label.slice(0, 14)}</SvgText>);
    });
    const zeroY = top + chartHeight - ((0 - minValue) / valueRange) * chartHeight;
    elements.push(<Line key="baseline" x1={left} y1={zeroY} x2={left + chartWidth} y2={zeroY} stroke="#CBD5E1" strokeWidth={1} />);
  } else {
    const chartHeight = 160; const top = 16; const left = 26; const right = 10;
    const chartWidth = Math.max(120, width - left - right);
    node.datasets.forEach((dataset: { data: number[] }, seriesIndex: number) => {
      const points: Array<readonly [number, number]> = dataset.data.map((value: number, index: number) => {
        const x = left + (dataset.data.length <= 1 ? chartWidth / 2 : (index / (dataset.data.length - 1)) * chartWidth);
        const y = top + chartHeight - ((value - minValue) / valueRange) * chartHeight;
        return [x, y] as const;
      });
      const seriesPath = points.map(([x, y]: readonly [number, number], index: number) => `${index === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ');
      const seriesColor = chartColor(seriesIndex);
      elements.push(<Path key={`line-${seriesIndex}`} d={seriesPath} stroke={seriesColor} strokeWidth={2.5} fill="none" />);
      points.forEach(([x, y]: readonly [number, number], index: number) => elements.push(<Circle key={`point-${seriesIndex}-${index}`} cx={x} cy={y} r={3} fill={seriesColor} />));
    });
    node.labels.forEach((label: string, index: number) => {
      const x = left + (node.labels.length <= 1 ? chartWidth / 2 : (index / (node.labels.length - 1)) * chartWidth);
      elements.push(<SvgText key={`xlabel-${index}`} {...svgAxisLabel(x, top + chartHeight + 18, font)}>{label.slice(0, 14)}</SvgText>);
    });
    const zeroY = top + chartHeight - ((0 - minValue) / valueRange) * chartHeight;
    elements.push(<Line key="base" x1={left} y1={zeroY} x2={left + chartWidth} y2={zeroY} stroke="#CBD5E1" strokeWidth={1} />);
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
  const rows = sourceLines.flatMap((line, index) => wrapCodeLine(line, metrics.columns).map((text, segment) => ({
    text, lineNumber: index + 1, continuation: segment > 0
  })));
  return { showLineNumbers, gutterWidth, metrics, rows };
}

function renderCodeBlock(node: any, theme: ThemeTokens, contentWidth: number): React.ReactElement {
  const dark = node.theme === 'dark';
  const background = dark ? '#1E293B' : '#F6F8FA';
  const foreground = dark ? '#E2E8F0' : '#24292F';
  const lineNumberColor = dark ? '#94A3B8' : '#8C959F';
  const highlighted = new Set<number>(node.highlightLines ?? []);
  const { showLineNumbers, gutterWidth, metrics, rows } = codeBlockLayout(node, contentWidth);
  const rowHeight = metrics.fontSize * CODE_LINE_HEIGHT;
  return (
    <View style={{ marginBottom: 12, borderWidth: 1, borderColor: dark ? '#334155' : '#D8DEE4', borderRadius: 4, overflow: 'hidden' }}>
      {node.title ? <View style={{ backgroundColor: dark ? '#0F172A' : '#EAEFF4', paddingHorizontal: 9, paddingVertical: 6 }}><PdfText style={{ fontSize: 8, color: dark ? '#CBD5E1' : '#475569', fontFamily: 'Courier' }}>{node.title}</PdfText></View> : null}
      <View style={{ backgroundColor: background, paddingVertical: 7, paddingHorizontal: 5 }}>
        {rows.map((row, index) => (
          <View key={index} wrap={false} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 1, minHeight: rowHeight, backgroundColor: highlighted.has(row.lineNumber) ? (dark ? '#334155' : '#FFF3C4') : background }}>
            {showLineNumbers ? (node.lineNumberStyle === 'text'
              ? <PdfText style={{ width: gutterWidth, textAlign: 'right', paddingRight: 7, fontSize: metrics.fontSize, color: lineNumberColor, fontFamily: theme.mono }}>{row.continuation ? '' : row.lineNumber}</PdfText>
              : <CodeGutter lineNumber={row.lineNumber} continuation={row.continuation} width={gutterWidth} fontSize={metrics.fontSize} color={lineNumberColor} />) : null}
            <PdfText style={{ flexGrow: 1, flexShrink: 1, fontSize: metrics.fontSize, lineHeight: CODE_LINE_HEIGHT, color: foreground, fontFamily: theme.mono }}>{renderHighlightedLine(row.text, node.language, foreground)}</PdfText>
          </View>
        ))}
      </View>
    </View>
  );
}

const FLOWCHART_STYLES: Record<FlowchartKind, { fill: string; border: string; text: string }> = {
  start: { fill: '#E8F0FE', border: '#2563EB', text: '#1E3A8A' },
  end: { fill: '#E8F0FE', border: '#2563EB', text: '#1E3A8A' },
  process: { fill: '#F8FAFC', border: '#94A3B8', text: '#0F172A' },
  decision: { fill: '#FFFBEB', border: '#D97706', text: '#78350F' },
  data: { fill: '#EFF6FF', border: '#60A5FA', text: '#1E3A8A' },
  document: { fill: '#F5F3FF', border: '#8B5CF6', text: '#4C1D95' },
  database: { fill: '#ECFDF5', border: '#10B981', text: '#064E3B' }
};

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
    const style = FLOWCHART_STYLES[item.kind] ?? FLOWCHART_STYLES.process;
    const border = item.color ?? style.border;
    elements.push(<React.Fragment key={`shape-${item.id}`}>{flowchartShape(item, border, style.fill)}</React.Fragment>);
    const centerX = item.x + item.width / 2;
    item.labelLines.forEach((line, lineIndex) => {
      const baseline = item.labelBaselines[lineIndex] ?? 0;
      elements.push(<SvgText key={`label-${item.id}-${lineIndex}`} {...svgFlowchartLabel(centerX, item.y + baseline, flowchartMetrics.LABEL_FONT, style.text, 700, context.theme.font)}>{line}</SvgText>);
    });
    item.descriptionLines.forEach((line, lineIndex) => {
      const baseline = item.descriptionBaselines[lineIndex] ?? 0;
      elements.push(<SvgText key={`desc-${item.id}-${lineIndex}`} {...svgFlowchartLabel(centerX, item.y + baseline, flowchartMetrics.DESCRIPTION_FONT, '#475569', undefined, context.theme.font)}>{line}</SvgText>);
    });
  });
  // Edge labels go last so they stay legible when they sit close to a box border.
  layout.edges.forEach((edge, index) => {
    if (!edge.label) return;
    const labelWidth = Math.min(layout.width - 4, edge.label.length * 3.4 + 7);
    const labelX = Math.max(2, Math.min(layout.width - labelWidth - 2, edge.labelX - labelWidth / 2));
    const labelY = Math.max(8, edge.labelY - 7);
    elements.push(<Rect key={`label-bg-${index}`} x={labelX} y={labelY} width={labelWidth} height={9.5} rx={2} fill="#FFFFFF" />);
    elements.push(<SvgText key={`label-text-${index}`} {...svgFlowchartLabel(labelX + labelWidth / 2, labelY + 7.4, 6.6, '#475569', undefined, context.theme.font)}>{edge.label}</SvgText>);
  });
  return (
    <Svg
      width={scale === 1 ? '100%' : layout.width * scale}
      height={layout.height * scale}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
    >{elements}</Svg>
  );
}

function renderNode(node: ComponentNode, context: RenderContext): React.ReactNode {
  const n = node as any;
  const t = context.theme;
  switch (n.type) {
    case 'PageBreak': return <View key={n.id} break />;
    case 'View': return <View key={n.id} wrap={n.wrap} style={{ flexDirection: n.direction, gap: n.gap, padding: n.padding, margin: n.margin, backgroundColor: n.backgroundColor, borderColor: n.borderColor, borderWidth: n.borderWidth, borderRadius: n.borderRadius, alignItems: n.align, justifyContent: n.justify }}>{n.children.map((child: ComponentNode, i: number) => <React.Fragment key={i}>{renderNode(child, context)}</React.Fragment>)}</View>;
    case 'Grid': {
      const rows: ComponentNode[][] = [];
      for (let i = 0; i < n.children.length; i += n.columns) rows.push(n.children.slice(i, i + n.columns));
      return <View key={n.id} style={{ gap: n.gap }}>
        {rows.map((row: ComponentNode[], rowIndex: number) => <View key={rowIndex} wrap={false} style={{ flexDirection: 'row', gap: n.gap }}>
          {row.map((child: ComponentNode, i: number) => <View key={i} style={{ flexGrow: 1, flexBasis: 0, minWidth: 0 }}>{renderNode(child, context)}</View>)}
          {row.length < n.columns ? Array.from({ length: n.columns - row.length }).map((_, i) => <View key={`empty-${i}`} style={{ flexGrow: 1, flexBasis: 0, minWidth: 0 }} />) : null}
        </View>)}
      </View>;
    }
    case 'Spacer': return <View key={n.id} style={n.axis === 'horizontal' ? { width: n.size } : { height: n.size }} />;
    case 'Divider': return <View key={n.id} style={{ borderTopWidth: n.thickness, borderTopColor: n.color, borderStyle: n.style, marginVertical: n.margin }} />;
    case 'DocumentHeader': {
      const logo = n.logoUrl ? context.images.get(n.logoUrl) : null;
      return <View key={n.id} wrap={false} style={{ flexDirection: 'column', alignItems: n.alignment === 'center' ? 'center' : 'stretch', borderBottomWidth: 2, borderBottomColor: t.primary, paddingBottom: 12, marginBottom: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: n.alignment === 'right' ? 'flex-end' : n.alignment === 'center' ? 'center' : 'space-between', gap: 12, flexGrow: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexGrow: 1, justifyContent: n.alignment === 'center' ? 'center' : 'flex-start' }}>
          {logo ? <PdfImage src={logo} style={{ width: 46, height: 46, objectFit: 'contain' }} /> : null}
          <View style={{ flexGrow: 1 }}>
            <PdfText style={{ fontSize: 21, fontWeight: 700, color: t.primary, fontFamily: t.font, textAlign: n.alignment, letterSpacing: -0.35 }}>{n.title}</PdfText>
            {n.subtitle ? <PdfText style={{ fontSize: 9, color: t.muted, marginTop: 3, textAlign: n.alignment }}>{n.subtitle}</PdfText> : null}
          </View>
          </View>
        </View>
        {n.badgeText ? <View style={{ backgroundColor: t.surface, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 3 }}><PdfText style={{ color: t.primary, fontSize: 8, fontWeight: 700 }}>{n.badgeText}</PdfText></View> : null}
        {n.logoUrl && !logo ? <PdfText style={{ fontSize: 7, color: t.muted }}>[Logo no disponible]</PdfText> : null}
      </View>;
    }
    case 'SectionTitle': {
      const sectionNumber = n.number ?? (n.autoNumber ? ++context.sectionCounter : undefined);
      return <View key={n.id} wrap={false} minPresenceAhead={120} style={{ marginTop: n.level === 1 ? 14 : 9, marginBottom: 7, borderBottomWidth: n.underline ? 1 : 0, borderBottomColor: t.border, paddingBottom: 5 }}><PdfText style={{ color: t.primary, fontSize: n.level === 1 ? 14 : n.level === 2 ? 12 : 10.5, fontWeight: 700, letterSpacing: n.level === 1 ? 0.1 : 0.2 }}>{sectionNumber !== undefined ? `${sectionNumber}. ` : ''}{n.title}</PdfText></View>;
    }
    case 'Text': return <PdfText key={n.id} style={{ color: n.color ?? t.text, fontSize: n.size, textAlign: n.align, fontWeight: n.weight === 'bold' ? 700 : 400, fontStyle: n.italic ? 'italic' : 'normal', lineHeight: n.lineHeight, marginBottom: n.marginBottom }}>{textRuns(n.text, t.mono, n.size)}</PdfText>;
    case 'Callout': {
      const palette: Record<string, { bg: string; border: string; fg: string }> = {
        info: { bg: '#EFF6FF', border: '#60A5FA', fg: '#1E40AF' }, warning: { bg: '#FFFBEB', border: '#F59E0B', fg: '#92400E' },
        success: { bg: '#ECFDF5', border: '#34D399', fg: '#065F46' }, danger: { bg: '#FEF2F2', border: '#F87171', fg: '#991B1B' }
      };
      const c = palette[n.variant] ?? palette.info!;
      return <View key={n.id} wrap={false} style={{ backgroundColor: c.bg, borderLeftWidth: 3, borderLeftColor: c.border, padding: 10, marginVertical: 7, borderRadius: 3 }}>
        {n.title ? <PdfText style={{ fontSize: 9, color: c.fg, fontWeight: 700, marginBottom: 3 }}>{n.icon ? `${n.icon} ` : ''}{n.title}</PdfText> : null}
        <PdfText style={{ fontSize: 9, color: c.fg, lineHeight: 1.35 }}>{textRuns(n.content, t.mono, 9)}</PdfText>
      </View>;
    }
    case 'DataTable': {
      const totalWidth = n.columns.reduce((sum: number, col: any) => sum + (col.width ?? (100 / n.columns.length)), 0);
      const widths = n.columns.map((col: any) => `${(col.width ?? (100 / n.columns.length)) / totalWidth * 100}%`);
      // A `fixed` header is repeated by react-pdf on every page, but if the table starts at
      // the bottom of a page it leaves an orphan header behind. Tables that fit on one page
      // are therefore kept indivisible with a normal header; only long tables use a fixed
      // header so it repeats on continuation pages. The estimate assumes two text lines per
      // row to stay conservative and never mark as indivisible a table that could overflow.
      // Reference tables (>12 rows) always flow: keeping them whole pushes a huge blank
      // band to the end of the previous page when only part of the page is left.
      const rowHeight = (n.compact ? 3 : 6) * 2 + 8 * 1.25 * 2;
      const estimatedHeight = (n.compact ? 5 : 7) * 2 + 8 + (n.caption ? 14 : 0) + 16 + n.rows.length * rowHeight;
      const fitsOnOnePage = n.rows.length <= 12 && estimatedHeight <= context.contentHeight;
      const header = <View fixed={!fitsOnOnePage} style={{ flexDirection: 'row', backgroundColor: t.primary, paddingVertical: n.compact ? 5 : 7, paddingHorizontal: 6 }}>
        {n.columns.map((column: any, index: number) => <PdfText key={column.key} style={{ width: widths[index], color: '#FFFFFF', fontSize: n.compact ? 7 : 8, fontWeight: 700, textAlign: column.align, letterSpacing: 0.25, paddingRight: 6 }}>{column.label}</PdfText>)}
      </View>;
      return <View key={n.id} wrap={!fitsOnOnePage} style={{ marginVertical: 8 }}>
        {n.caption ? <PdfText style={{ color: t.muted, fontSize: 8, marginBottom: 5 }}>{n.caption}</PdfText> : null}
        {header}
        {n.rows.map((row: Record<string, unknown>, rowIndex: number) => <View key={rowIndex} wrap={false} style={{ flexDirection: 'row', paddingVertical: n.compact ? 3 : 6, paddingHorizontal: 6, backgroundColor: n.zebra && rowIndex % 2 === 1 ? t.surface : '#FFFFFF', borderBottomWidth: 0.5, borderBottomColor: t.border }}>
          {n.columns.map((column: any, index: number) => <PdfText key={column.key} style={{ width: widths[index], color: t.text, fontSize: n.compact ? 7 : 8, textAlign: column.align, lineHeight: 1.25, paddingRight: 6 }}>{formatCell(row[column.key], column.format, n.currency, n.locale)}</PdfText>)}
        </View>)}
      </View>;
    }
    case 'KeyValueList': return <View key={n.id} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 6 }}>{n.items.map((item: any, index: number) => <View key={index} wrap={false} style={{ width: n.columns === 1 ? '100%' : '48%', paddingVertical: 5, borderBottomWidth: 0.5, borderBottomColor: t.border }}><PdfText style={{ fontSize: 7.5, color: t.muted, marginBottom: 2 }}>{item.key}</PdfText><PdfText style={{ fontSize: 9, color: t.text, fontWeight: 700 }}>{String(item.value ?? '-')}</PdfText></View>)}</View>;
    case 'MetricCard': return <View key={n.id} wrap={false} style={{ borderWidth: 1, borderColor: t.border, borderRadius: 5, padding: 10, backgroundColor: '#FFFFFF', marginBottom: 7 }}>
      <PdfText style={{ color: t.muted, fontSize: 8 }}>{n.label}</PdfText>
      <PdfText style={{ color: t.primary, fontSize: 19, fontWeight: 700, marginTop: 5 }}>{String(n.value ?? '-')}</PdfText>
      {n.trend ? <PdfText style={{ color: n.trendColor ?? '#0F8A5F', fontSize: 8, fontWeight: 700, marginTop: 3 }}>{n.trend}</PdfText> : null}
      {n.description ? <PdfText style={{ color: t.muted, fontSize: 7, marginTop: 4 }}>{n.description}</PdfText> : null}
    </View>;
    case 'Chart': return <View key={n.id} wrap={false} style={{ marginVertical: 8 }}>
      {n.title ? <PdfText style={{ color: t.primary, fontSize: 10, fontWeight: 700, textAlign: 'center', marginBottom: 5 }}>{n.title}</PdfText> : null}
      <ChartGraphic node={n} width={context.contentWidth} font={t.font} />
      {n.showLegend ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 3 }}>{(n.chartType === 'pie' || n.chartType === 'doughnut' ? n.labels.map((label: string) => ({ label })) : n.datasets.map((dataset: any) => ({ label: dataset.label }))).map((entry: { label: string }, index: number) => <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: chartColor(index) }} /><PdfText style={{ fontSize: 7, color: t.muted }}>{entry.label}</PdfText></View>)}</View> : null}
    </View>;
    case 'CodeBlock': {
      // Keep short code blocks on a single page: a title plus one trailing line at the
      // bottom of a page looks broken. Long blocks still flow across pages line by line.
      const layout = codeBlockLayout(n, context.contentWidth);
      const estimated = Math.ceil(layout.rows.length * layout.metrics.fontSize * CODE_LINE_HEIGHT * 1.15) + (n.title ? 24 : 0) + 28;
      return <View key={n.id} wrap={estimated > context.contentHeight}>{renderCodeBlock(n, t, context.contentWidth)}</View>;
    }
    case 'Image': {
      const image = context.images.get(n.src);
      return <View key={n.id} wrap={false} style={{ alignItems: n.align === 'left' ? 'flex-start' : n.align === 'right' ? 'flex-end' : 'center', marginVertical: 6 }}>
        {image ? <PdfImage src={image} style={{ width: n.width ?? 420, maxWidth: '100%', height: n.height, objectFit: n.fit === 'width' ? 'contain' : n.fit }} /> : <PdfText style={{ color: t.muted, fontSize: 8, padding: 12, borderWidth: 0.5, borderColor: t.border }}>[Imagen no disponible]</PdfText>}
        {n.caption ? <PdfText style={{ color: t.muted, fontSize: 7, marginTop: 4, width: '100%', textAlign: n.align }}>{n.caption}</PdfText> : null}
      </View>;
    }
    case 'QRCode': {
      const qr = context.qrCodes.get(n.value);
      return <View key={n.id} wrap={false} style={{ alignItems: 'center', marginVertical: 8 }}>
        {qr ? <PdfImage src={qr} style={{ width: n.size, height: n.size, maxWidth: '100%', maxHeight: '100%' }} /> : <PdfText style={{ color: t.muted, fontSize: 8, padding: 8, borderWidth: 0.5, borderColor: t.border }}>[QR no disponible]</PdfText>}
        {n.caption ? <PdfText style={{ color: t.muted, fontSize: 7, marginTop: 4 }}>{n.caption}</PdfText> : null}
      </View>;
    }
    case 'SignatureBlock': return <View key={n.id} wrap={false} style={{ flexDirection: 'row', justifyContent: 'space-around', gap: 18, marginTop: 32 }}>
      {n.signers.map((signer: any, index: number) => <View key={index} style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, alignItems: 'center' }}>
        <View style={{ height: 38, width: '100%' }} /><View style={{ width: '100%', borderTopWidth: 1, borderTopColor: '#475569', marginBottom: 5 }} />
        <PdfText style={{ color: t.text, fontSize: 8, fontWeight: 700, textAlign: 'center' }}>{signer.name}</PdfText>
        <PdfText style={{ color: t.muted, fontSize: 7, textAlign: 'center' }}>{signer.role}</PdfText>
        {signer.date ? <PdfText style={{ color: t.muted, fontSize: 7, marginTop: 2 }}>{signer.date}</PdfText> : null}
      </View>)}
    </View>;
    case 'InvoiceSummary': return <View key={n.id} wrap={false} style={{ alignSelf: 'flex-end', width: '58%', backgroundColor: t.surface, padding: 10, borderRadius: 4, marginVertical: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 }}><PdfText style={{ fontSize: 8, color: t.muted }}>Subtotal</PdfText><PdfText style={{ fontSize: 8, color: t.text }}>{formatMoney(n.subtotal, n.currency, n.locale)}</PdfText></View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 }}><PdfText style={{ fontSize: 8, color: t.muted }}>Impuestos</PdfText><PdfText style={{ fontSize: 8, color: t.text }}>{formatMoney(n.tax, n.currency, n.locale)}</PdfText></View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 }}><PdfText style={{ fontSize: 8, color: t.muted }}>Descuento</PdfText><PdfText style={{ fontSize: 8, color: t.text }}>-{formatMoney(n.discount, n.currency, n.locale)}</PdfText></View>
      <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: 6, flexDirection: 'row', justifyContent: 'space-between' }}><PdfText style={{ fontSize: 10, color: t.primary, fontWeight: 700 }}>TOTAL</PdfText><PdfText style={{ fontSize: 12, color: t.primary, fontWeight: 700 }}>{formatMoney(n.total, n.currency, n.locale)}</PdfText></View>
      {n.notes ? <PdfText style={{ fontSize: 7, color: t.muted, marginTop: 6 }}>{n.notes}</PdfText> : null}
    </View>;
    case 'BulletList': return <View key={n.id} style={{ marginVertical: 6 }}>{n.items.map((item: string, index: number) => <View key={index} wrap={false} style={{ flexDirection: 'row', gap: 7, marginBottom: 4 }}><PdfText style={{ color: t.accent, fontSize: 9 }}>{n.ordered ? `${index + 1}.` : '•'}</PdfText><PdfText style={{ color: t.text, fontSize: 9, flexGrow: 1, lineHeight: 1.35 }}>{textRuns(item, t.mono, 9)}</PdfText></View>)}</View>;
    case 'Flowchart': return <View key={n.id} wrap={false} style={{ marginVertical: 8 }}>
      {n.title ? <PdfText style={{ fontSize: 9.5, fontWeight: 700, color: t.primary, marginBottom: 6, textAlign: n.titleAlign, letterSpacing: 0.15 }}>{n.title}</PdfText> : null}
      <View style={{ alignItems: 'center' }}><FlowchartGraphic node={n} context={context} /></View>
      {n.caption ? <PdfText style={{ fontSize: 7.5, color: t.muted, marginTop: 5, textAlign: n.captionAlign }}>{n.caption}</PdfText> : null}
    </View>;
    default: throw new AppError(`Componente no implementado: ${String(n.type)}`, 'UNSUPPORTED_COMPONENT', `content.${n.id ?? 'unknown'}`);
  }
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

export interface RenderResult { bytes: Buffer; pageCount: number; warnings: string[] }

export async function renderPdf(input: GeneratePdfInput): Promise<RenderResult> {
  await registerOptionalFonts();
  const theme = resolveTheme(input.theme);
  const [{ images, warnings }, { codes: qrCodes, warnings: qrWarnings }] = await Promise.all([prepareImages(input.content), prepareQrCodes(input.content)]);
  warnings.push(...qrWarnings);
  if (input.theme.fontFamily !== theme.font) {
    warnings.push(`La familia tipográfica '${input.theme.fontFamily}' no está instalada en PDF_MCP_FONT_DIR; se usó '${theme.font}'. Copia los TTF de la familia para activarla.`);
  }
  const context: RenderContext = { theme, images, qrCodes, sectionCounter: 0, contentHeight: 0, contentWidth: 0, warnings };
  const pageMargins = input.settings.margins;
  // The fixed header/footer live inside the page margins. Adding the full chrome height
  // to the margin (the previous behaviour) counted the same space twice and left a large
  // blank band between the header rule and the first line of every page.
  const chromeOffset = 18;
  const chromeGap = 12;
  const paddingTop = input.fixedHeader
    ? Math.max(pageMargins.top, chromeOffset + input.fixedHeader.height + chromeGap)
    : pageMargins.top;
  const paddingBottom = input.fixedFooter
    ? Math.max(pageMargins.bottom, chromeOffset + input.fixedFooter.height + chromeGap)
    : pageMargins.bottom;
  const pageDimensions = PAGE_DIMENSIONS[input.settings.pageSize] ?? PAGE_DIMENSIONS.A4!;
  const pageHeight = input.settings.orientation === 'landscape' ? pageDimensions.width : pageDimensions.height;
  const pageWidth = input.settings.orientation === 'landscape' ? pageDimensions.height : pageDimensions.width;
  context.contentHeight = Math.max(120, pageHeight - paddingTop - paddingBottom - 12);
  context.contentWidth = Math.max(160, pageWidth - pageMargins.left - pageMargins.right);
  const content = input.content.map((node: ComponentNode, index: number) => <React.Fragment key={index}>{renderNode(node, context)}</React.Fragment>);

  const doc = (
    <Document
      title={input.metadata?.title ?? input.filename}
      author={input.metadata?.author ?? 'MCP PDF Server'}
      {...(input.metadata?.subject ? { subject: input.metadata.subject } : {})}
      {...(input.metadata?.keywords?.length ? { keywords: input.metadata.keywords.join(', ') } : {})}
      creator="mcp-pdf-server"
      producer="mcp-pdf-server / @react-pdf/renderer"
    >
      <Page size={input.settings.pageSize} orientation={input.settings.orientation} style={{ paddingTop, paddingBottom, paddingHorizontal: pageMargins.left, fontFamily: theme.font, fontSize: 9, color: theme.text }}>
        {input.fixedHeader ? <View fixed style={{ position: 'absolute', top: chromeOffset, left: pageMargins.left, right: pageMargins.right, height: input.fixedHeader.height, justifyContent: 'center', borderBottomWidth: input.fixedHeader.showRule ? 0.6 : 0, borderBottomColor: theme.border }}><PdfText style={{ color: theme.muted, fontSize: 7.5 }} render={({ pageNumber, totalPages }) => (input.fixedHeader?.text ?? input.metadata?.title ?? input.filename).replaceAll('{{pageNumber}}', String(pageNumber)).replaceAll('{{totalPages}}', String(totalPages))} /></View> : null}
        {content}
        {input.fixedFooter ? <View fixed style={{ position: 'absolute', bottom: chromeOffset, left: pageMargins.left, right: pageMargins.right, height: input.fixedFooter.height, justifyContent: 'center', borderTopWidth: input.fixedFooter.showRule ? 0.6 : 0, borderTopColor: theme.border }}>
          <PdfText style={{ color: theme.muted, fontSize: 7, textAlign: 'center' }} render={({ pageNumber, totalPages }) => `${input.fixedFooter?.text ? `${input.fixedFooter.text.replaceAll('{{pageNumber}}', String(pageNumber)).replaceAll('{{totalPages}}', String(totalPages))}   ` : ''}${input.fixedFooter?.showPageNumbers === false ? '' : `Página ${pageNumber} de ${totalPages}`}`} />
        </View> : null}
      </Page>
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
  const bytes = Buffer.concat(chunks, totalBytes);
  if (bytes.byteLength === 0) throw new AppError('El motor PDF devolvió un archivo vacío.', 'RENDER_EMPTY_OUTPUT');
  const parsed = await PDFDocument.load(bytes, { ignoreEncryption: false });
  return { bytes, pageCount: parsed.getPageCount(), warnings };
}
