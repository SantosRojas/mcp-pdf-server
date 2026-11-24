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
import { LINE_HEIGHT, RADIUS, SPACE, TRACKING, TYPE, metricValueSize, withAlpha } from './design.js';
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

function textRuns(text: string, mono = 'Courier', parentSize?: number, monoColor = '#334155'): React.ReactNode[] {
  return splitInlineMarkup(text).map((run, index) => {
    if (run.kind === 'bold') return <PdfText key={index} style={{ fontWeight: 700 }}>{run.text}</PdfText>;
    // Mono faces have a larger optical size than the text face; 92% keeps the run in rhythm.
    if (run.kind === 'code') return <PdfText key={index} style={{ fontFamily: mono, fontFeatureSettings: NO_LIGATURES, color: monoColor, ...(parentSize ? { fontSize: Math.round(parentSize * 0.92 * 10) / 10 } : {}) }}>{run.text}</PdfText>;
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

function ChartGraphic({ node, width, font, palette }: { node: any; width: number; font: string; palette: string[] }): React.ReactElement {
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
        elements.push(<Circle key={`slice-${index}`} cx={centerX} cy={centerY} r={radius} fill={chartColor(palette, index)} />);
        if (node.chartType === 'doughnut') elements.push(<Circle key="doughnut-hole" cx={centerX} cy={centerY} r={hole} fill="#FFFFFF" />);
      } else if (sweep > 0) {
        elements.push(<Path key={`slice-${index}`} d={arcPath(centerX, centerY, radius, cursor, cursor + sweep, node.chartType === 'doughnut' ? hole : 0)} fill={chartColor(palette, index)} />);
      }
      cursor += sweep;
    });
  } else {
    const isBar = node.chartType === 'bar';
    const chartHeight = isBar ? 158 : 160;
    const top = 12;
    // The left gutter hosts the value axis; the previous version had no y scale at all.
    const left = 44;
    const right = 12;
    const chartWidth = Math.max(120, width - left - right);
    const yFor = (value: number) => top + chartHeight - ((value - minValue) / valueRange) * chartHeight;
    const ticks = 4;
    for (let tick = 0; tick <= ticks; tick += 1) {
      const value = minValue + (valueRange * tick) / ticks;
      const y = yFor(value);
      const isZero = Math.abs(value) < 1e-9;
      elements.push(<Line key={`grid-${tick}`} x1={left} y1={y} x2={left + chartWidth} y2={y} stroke={isZero ? '#CBD5E1' : '#E7ECF2'} strokeWidth={isZero ? 1 : 0.6} />);
      elements.push(<SvgText key={`grid-label-${tick}`} {...svgValueLabel(left - 7, y + 2.6, font)}>{compactNumber(value)}</SvgText>);
    }
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
        elements.push(<SvgText key={`label-${index}`} {...svgAxisLabel(left + index * groupWidth + groupWidth / 2, top + chartHeight + 18, font)}>{label.slice(0, 14)}</SvgText>);
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
        const x = left + (node.labels.length <= 1 ? chartWidth / 2 : (index / (node.labels.length - 1)) * chartWidth);
        elements.push(<SvgText key={`xlabel-${index}`} {...svgAxisLabel(x, top + chartHeight + 18, font)}>{label.slice(0, 14)}</SvgText>);
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
    <View style={{ marginBottom: SPACE.lg, borderWidth: 1, borderColor: dark ? '#334155' : '#D8DEE4', borderRadius: RADIUS.md, overflow: 'hidden' }}>
      {node.title ? (
        <View style={{ backgroundColor: dark ? '#0F172A' : '#EAEFF4', borderBottomWidth: 0.5, borderBottomColor: dark ? '#334155' : '#D8DEE4', paddingHorizontal: 9, paddingVertical: 6 }}>
          <PdfText style={{ fontSize: TYPE.caption, fontWeight: 600, color: dark ? '#CBD5E1' : '#334155', fontFamily: theme.heading }}>{node.title}</PdfText>
        </View>
      ) : null}
      <View style={{ backgroundColor: background, paddingVertical: 7, paddingHorizontal: 5 }}>
        {rows.map((row, index) => (
          <View key={index} wrap={false} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 1, minHeight: rowHeight, backgroundColor: highlighted.has(row.lineNumber) ? (dark ? '#334155' : '#FFF3C4') : background }}>
            {showLineNumbers ? (node.lineNumberStyle === 'text'
              ? <PdfText style={{ width: gutterWidth, textAlign: 'right', paddingRight: 7, fontSize: metrics.fontSize, color: lineNumberColor, fontFamily: theme.mono, fontFeatureSettings: NO_LIGATURES }}>{row.continuation ? '' : row.lineNumber}</PdfText>
              : <CodeGutter lineNumber={row.lineNumber} continuation={row.continuation} width={gutterWidth} fontSize={metrics.fontSize} color={lineNumberColor} />) : null}
            <PdfText style={{ flexGrow: 1, flexShrink: 1, fontSize: metrics.fontSize, lineHeight: CODE_LINE_HEIGHT, color: foreground, fontFamily: theme.mono, fontFeatureSettings: NO_LIGATURES }}>{renderHighlightedLine(row.text, node.language, foreground, dark)}</PdfText>
          </View>
        ))}
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
      const centered = n.alignment === 'center';
      return <View key={n.id} wrap={false} style={{ marginBottom: SPACE.xl }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.lg, justifyContent: centered ? 'center' : 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.lg, flexGrow: 1, justifyContent: centered ? 'center' : 'flex-start' }}>
            {logo ? <PdfImage src={logo} style={{ width: 48, height: 48, objectFit: 'contain' }} /> : null}
            <View style={{ flexGrow: 1 }}>
              <PdfText style={{ fontSize: TYPE.display, fontWeight: 700, color: t.primary, fontFamily: t.heading, textAlign: n.alignment, letterSpacing: TRACKING.display, lineHeight: LINE_HEIGHT.tight }}>{n.title}</PdfText>
              {n.subtitle ? <PdfText style={{ fontSize: TYPE.small, color: t.muted, marginTop: 3, textAlign: n.alignment, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{n.subtitle}</PdfText> : null}
            </View>
          </View>
          {n.badgeText ? <View style={{ backgroundColor: t.surface, borderWidth: 0.5, borderColor: t.border, paddingHorizontal: 8, paddingVertical: 5, borderRadius: RADIUS.pill }}><PdfText style={{ color: t.primary, fontSize: TYPE.micro, fontWeight: 700, letterSpacing: TRACKING.wide, fontFamily: t.heading }}>{n.badgeText}</PdfText></View> : null}
        </View>
        <View style={{ marginTop: SPACE.md, borderBottomWidth: 1, borderBottomColor: t.border }}>
          <View style={{ width: 64, height: 2.5, backgroundColor: t.accent, borderRadius: RADIUS.sm }} />
        </View>
        {n.logoUrl && !logo ? <PdfText style={{ fontSize: TYPE.tiny, color: t.muted, marginTop: 2 }}>[Logo no disponible]</PdfText> : null}
      </View>;
    }
    case 'SectionTitle': {
      const sectionNumber = n.number ?? (n.autoNumber ? ++context.sectionCounter : undefined);
      const size = n.level === 1 ? TYPE.h1 : n.level === 2 ? TYPE.h2 : TYPE.h3;
      const weight = n.level === 1 ? 700 : 600;
      return <View key={n.id} wrap={false} minPresenceAhead={120} style={{ marginTop: n.level === 1 ? 14 : 9, marginBottom: 7, borderBottomWidth: n.underline ? 0.75 : 0, borderBottomColor: t.border, paddingBottom: 5 }}>
        <PdfText style={{ color: t.primary, fontSize: size, fontWeight: weight, fontFamily: t.heading, letterSpacing: TRACKING.heading, lineHeight: LINE_HEIGHT.tight }}>
          {sectionNumber !== undefined ? <PdfText style={{ color: t.accent }}>{`${sectionNumber}. `}</PdfText> : null}
          {n.title}
        </PdfText>
      </View>;
    }
    case 'Text': return <PdfText key={n.id} style={{ color: n.color ?? t.text, fontSize: n.size, textAlign: n.align, fontWeight: n.weight === 'bold' ? 700 : n.weight === 'semibold' ? 600 : 400, fontStyle: n.italic ? 'italic' : 'normal', lineHeight: n.lineHeight, marginBottom: n.marginBottom, fontFamily: t.font }}>{textRuns(n.text, t.mono, n.size, t.primary)}</PdfText>;
    case 'Callout': {
      const c = t.callouts[(n.variant ?? 'info') as keyof typeof t.callouts] ?? t.callouts.info;
      return <View key={n.id} wrap={false} style={{ backgroundColor: c.background, borderLeftWidth: 3, borderLeftColor: c.border, padding: SPACE.lg, marginVertical: SPACE.sm, borderRadius: RADIUS.md }}>
        {n.title ? <PdfText style={{ fontSize: TYPE.small, color: c.foreground, fontWeight: 600, marginBottom: SPACE.xs, letterSpacing: TRACKING.wide, fontFamily: t.heading }}>{n.icon ? `${n.icon} ` : ''}{n.title}</PdfText> : null}
        <PdfText style={{ fontSize: TYPE.small, color: c.foreground, lineHeight: LINE_HEIGHT.relaxed, fontFamily: t.font }}>{textRuns(n.content, t.mono, TYPE.small, t.primary)}</PdfText>
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
      const estimatedHeight = (n.compact ? 5 : 7) * 2 + TYPE.caption + (n.caption ? 14 : 0) + 16 + n.rows.length * rowHeight;
      const fitsOnOnePage = n.rows.length <= 12 && estimatedHeight <= context.contentHeight;
      const header = <View fixed={!fitsOnOnePage} style={{ flexDirection: 'row', backgroundColor: t.primary, paddingVertical: n.compact ? 5 : 7, paddingHorizontal: 6, borderTopLeftRadius: RADIUS.sm, borderTopRightRadius: RADIUS.sm }}>
        {n.columns.map((column: any, index: number) => <PdfText key={column.key} style={{ width: widths[index], color: t.onPrimary, fontSize: n.compact ? 7 : 8, fontWeight: 700, textAlign: column.align, letterSpacing: 0.25, paddingRight: 6, fontFamily: t.heading }}>{column.label}</PdfText>)}
      </View>;
      return <View key={n.id} wrap={!fitsOnOnePage} style={{ marginVertical: SPACE.md }}>
        {n.caption ? <PdfText style={{ color: t.muted, fontSize: TYPE.caption, marginBottom: SPACE.xs + 1, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{n.caption}</PdfText> : null}
        {header}
        {n.rows.map((row: Record<string, unknown>, rowIndex: number) => <View key={rowIndex} wrap={false} style={{ flexDirection: 'row', paddingVertical: n.compact ? 3 : 6, paddingHorizontal: 6, backgroundColor: n.zebra && rowIndex % 2 === 1 ? t.surface : '#FFFFFF', borderBottomWidth: 0.5, borderBottomColor: t.border }}>
          {n.columns.map((column: any, index: number) => <PdfText key={column.key} style={{ width: widths[index], color: t.text, fontSize: n.compact ? 7 : 8, textAlign: column.align, lineHeight: 1.25, paddingRight: 6, fontFamily: t.font }}>{formatCell(row[column.key], column.format, n.currency, n.locale)}</PdfText>)}
        </View>)}
      </View>;
    }
    case 'KeyValueList': return <View key={n.id} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.md, marginVertical: SPACE.sm }}>{n.items.map((item: any, index: number) => <View key={index} wrap={false} style={{ width: n.columns === 1 ? '100%' : '48%', paddingVertical: 5, borderBottomWidth: 0.5, borderBottomColor: t.border }}><PdfText style={{ fontSize: TYPE.micro, color: t.muted, marginBottom: 2, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{item.key}</PdfText><PdfText style={{ fontSize: TYPE.small, color: t.text, fontWeight: 600, fontFamily: t.heading }}>{String(item.value ?? '-')}</PdfText></View>)}</View>;
    case 'MetricCard': {
      const value = String(n.value ?? '-');
      const trendColor = n.trendColor ?? '#0F8A5F';
      return <View key={n.id} wrap={false} style={{ borderWidth: 0.75, borderColor: t.border, borderTopWidth: 2.5, borderTopColor: t.accent, borderRadius: RADIUS.lg, padding: 10, backgroundColor: '#FFFFFF', marginBottom: 7 }}>
        <PdfText style={{ color: t.muted, fontSize: TYPE.caption, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{n.label}</PdfText>
        <PdfText style={{ color: t.primary, fontSize: metricValueSize(value), fontWeight: 700, marginTop: SPACE.xs, lineHeight: LINE_HEIGHT.tight, fontFamily: t.heading }}>{value}</PdfText>
        {n.trend ? <View style={{ alignSelf: 'flex-start', marginTop: SPACE.xs, backgroundColor: withAlpha(trendColor, 0.12), borderRadius: RADIUS.pill, paddingHorizontal: 5, paddingVertical: 1.5 }}><PdfText style={{ color: trendColor, fontSize: TYPE.micro, fontWeight: 600, fontFamily: t.font }}>{n.trend}</PdfText></View> : null}
        {n.description ? <PdfText style={{ color: t.muted, fontSize: TYPE.tiny, marginTop: SPACE.xs, lineHeight: LINE_HEIGHT.normal, fontFamily: t.font }}>{n.description}</PdfText> : null}
      </View>;
    }
    case 'Chart': return <View key={n.id} wrap={false} style={{ marginVertical: SPACE.md }}>
      {n.title ? <PdfText style={{ color: t.primary, fontSize: TYPE.small + 1, fontWeight: 600, textAlign: 'center', marginBottom: SPACE.sm, letterSpacing: TRACKING.heading, fontFamily: t.heading }}>{n.title}</PdfText> : null}
      <ChartGraphic node={n} width={context.contentWidth} font={t.font} palette={t.chart} />
      {n.showLegend ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: SPACE.lg, marginTop: SPACE.xs }}>{(n.chartType === 'pie' || n.chartType === 'doughnut' ? n.labels.map((label: string) => ({ label })) : n.datasets.map((dataset: any) => ({ label: dataset.label }))).map((entry: { label: string }, index: number) => <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.xs }}><View style={{ width: 8, height: 8, borderRadius: RADIUS.sm, backgroundColor: chartColor(t.chart, index) }} /><PdfText style={{ fontSize: TYPE.micro, color: t.muted, fontFamily: t.font }}>{entry.label}</PdfText></View>)}</View> : null}
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
      return <View key={n.id} wrap={false} style={{ alignItems: n.align === 'left' ? 'flex-start' : n.align === 'right' ? 'flex-end' : 'center', marginVertical: SPACE.sm }}>
        {image ? <PdfImage src={image} style={{ width: n.width ?? 420, maxWidth: '100%', height: n.height, objectFit: n.fit === 'width' ? 'contain' : n.fit }} /> : <PdfText style={{ color: t.muted, fontSize: TYPE.micro, padding: SPACE.lg, borderWidth: 0.5, borderColor: t.border }}>[Imagen no disponible]</PdfText>}
        {n.caption ? <PdfText style={{ color: t.muted, fontSize: TYPE.micro, marginTop: SPACE.xs, width: '100%', textAlign: n.align, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{n.caption}</PdfText> : null}
      </View>;
    }
    case 'QRCode': {
      const qr = context.qrCodes.get(n.value);
      return <View key={n.id} wrap={false} style={{ alignItems: 'center', marginVertical: SPACE.md }}>
        {qr ? <PdfImage src={qr} style={{ width: n.size, height: n.size, maxWidth: '100%', maxHeight: '100%' }} /> : <PdfText style={{ color: t.muted, fontSize: TYPE.micro, padding: SPACE.md, borderWidth: 0.5, borderColor: t.border }}>[QR no disponible]</PdfText>}
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
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 }}><PdfText style={{ fontSize: TYPE.caption, color: t.muted, letterSpacing: TRACKING.wide, fontFamily: t.font }}>Subtotal</PdfText><PdfText style={{ fontSize: TYPE.caption + 0.5, color: t.text, fontFamily: t.font }}>{formatMoney(n.subtotal, n.currency, n.locale)}</PdfText></View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 }}><PdfText style={{ fontSize: TYPE.caption, color: t.muted, letterSpacing: TRACKING.wide, fontFamily: t.font }}>Impuestos</PdfText><PdfText style={{ fontSize: TYPE.caption + 0.5, color: t.text, fontFamily: t.font }}>{formatMoney(n.tax, n.currency, n.locale)}</PdfText></View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 }}><PdfText style={{ fontSize: TYPE.caption, color: t.muted, letterSpacing: TRACKING.wide, fontFamily: t.font }}>Descuento</PdfText><PdfText style={{ fontSize: TYPE.caption + 0.5, color: t.text, fontFamily: t.font }}>-{formatMoney(n.discount, n.currency, n.locale)}</PdfText></View>
      <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: SPACE.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}><PdfText style={{ fontSize: TYPE.small, color: t.primary, fontWeight: 700, letterSpacing: TRACKING.caps, fontFamily: t.heading }}>TOTAL</PdfText><PdfText style={{ fontSize: TYPE.h2, color: t.primary, fontWeight: 700, fontFamily: t.heading }}>{formatMoney(n.total, n.currency, n.locale)}</PdfText></View>
      {n.notes ? <PdfText style={{ fontSize: TYPE.tiny, color: t.muted, marginTop: SPACE.sm, fontFamily: t.font }}>{n.notes}</PdfText> : null}
    </View>;
    case 'BulletList': return <View key={n.id} style={{ marginVertical: SPACE.sm }}>{n.items.map((item: string, index: number) => <View key={index} wrap={false} style={{ flexDirection: 'row', gap: SPACE.md, marginBottom: SPACE.xs + 1 }}><PdfText style={{ color: t.accent, fontSize: TYPE.small + 0.5, minWidth: 12, fontFamily: t.font }}>{n.ordered ? `${index + 1}.` : '•'}</PdfText><PdfText style={{ color: t.text, fontSize: TYPE.small + 0.5, flexGrow: 1, lineHeight: LINE_HEIGHT.relaxed, fontFamily: t.font }}>{textRuns(item, t.mono, TYPE.small + 0.5, t.primary)}</PdfText></View>)}</View>;
    case 'Flowchart': return <View key={n.id} wrap={false} style={{ marginVertical: SPACE.md }}>
      {n.title ? <PdfText style={{ fontSize: TYPE.small + 0.5, fontWeight: 600, color: t.primary, marginBottom: SPACE.sm, textAlign: n.titleAlign, letterSpacing: TRACKING.heading, fontFamily: t.heading }}>{n.title}</PdfText> : null}
      <View style={{ alignItems: 'center' }}><FlowchartGraphic node={n} context={context} /></View>
      {n.caption ? <PdfText style={{ fontSize: TYPE.micro, color: t.muted, marginTop: SPACE.xs + 1, textAlign: n.captionAlign, letterSpacing: TRACKING.wide, fontFamily: t.font }}>{n.caption}</PdfText> : null}
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
  const { theme, warnings: fontWarnings } = resolveTheme(input.theme);
  const [{ images, warnings }, { codes: qrCodes, warnings: qrWarnings }] = await Promise.all([prepareImages(input.content), prepareQrCodes(input.content)]);
  warnings.push(...fontWarnings, ...qrWarnings);
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
        {input.fixedHeader ? <View fixed style={{ position: 'absolute', top: chromeOffset, left: pageMargins.left, right: pageMargins.right, height: input.fixedHeader.height, justifyContent: 'center', borderBottomWidth: input.fixedHeader.showRule ? 0.6 : 0, borderBottomColor: theme.border }}><PdfText style={{ color: theme.muted, fontSize: TYPE.micro, letterSpacing: TRACKING.wide, fontFamily: theme.font }} render={({ pageNumber, totalPages }) => (input.fixedHeader?.text ?? input.metadata?.title ?? input.filename).replaceAll('{{pageNumber}}', String(pageNumber)).replaceAll('{{totalPages}}', String(totalPages))} /></View> : null}
        {content}
        {input.fixedFooter ? <View fixed style={{ position: 'absolute', bottom: chromeOffset, left: pageMargins.left, right: pageMargins.right, height: input.fixedFooter.height, justifyContent: 'center', borderTopWidth: input.fixedFooter.showRule ? 0.6 : 0, borderTopColor: theme.border }}>
          <PdfText style={{ color: theme.muted, fontSize: TYPE.tiny, textAlign: 'center', letterSpacing: TRACKING.wide, fontFamily: theme.font }} render={({ pageNumber, totalPages }) => `${input.fixedFooter?.text ? `${input.fixedFooter.text.replaceAll('{{pageNumber}}', String(pageNumber)).replaceAll('{{totalPages}}', String(totalPages))}   ` : ''}${input.fixedFooter?.showPageNumbers === false ? '' : `Página ${pageNumber} de ${totalPages}`}`} />
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
