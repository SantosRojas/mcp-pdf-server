// Pure layout math for the Flowchart component.
//
// The renderer must know every coordinate before react-pdf lays the page out, so
// the graph is positioned deterministically here: nodes are assigned to layers
// (longest path over the acyclic part of the graph), each layer becomes a row of
// boxes, and edges are routed orthogonally between rows. Nothing in this module
// touches react-pdf, which keeps the math unit-testable.

export type FlowchartDirection = 'vertical' | 'horizontal';
export type FlowchartKind = 'start' | 'process' | 'decision' | 'data' | 'document' | 'database' | 'end';
export type FlowchartEdgeStyle = 'solid' | 'dashed';
export type ArrowDirection = 'up' | 'down' | 'left' | 'right';

export interface FlowchartNodeInput {
  id: string;
  label: string;
  description?: string;
  kind: FlowchartKind;
  color?: string;
}

export interface FlowchartEdgeInput {
  from: string;
  to: string;
  label?: string;
  style: FlowchartEdgeStyle;
}

export interface FlowchartLayoutOptions {
  nodes: FlowchartNodeInput[];
  edges: FlowchartEdgeInput[];
  direction: FlowchartDirection;
  /** Available content width in points. */
  width: number;
}

export interface PositionedFlowchartNode extends FlowchartNodeInput {
  x: number;
  y: number;
  width: number;
  height: number;
  labelLines: string[];
  descriptionLines: string[];
  /** Horizontal inset applied to text so it stays inside a diamond/parallelogram. */
  textInset: number;
  /** Distance from the node centre to where each line is drawn. */
  labelBaselines: number[];
  descriptionBaselines: number[];
}

export interface RoutedFlowchartEdge extends FlowchartEdgeInput {
  points: Array<{ x: number; y: number }>;
  arrow: ArrowDirection;
  labelX: number;
  labelY: number;
  loop: boolean;
}

export interface FlowchartLayoutResult {
  width: number;
  height: number;
  nodes: PositionedFlowchartNode[];
  edges: RoutedFlowchartEdge[];
}

const LABEL_FONT = 8.4;
const DESCRIPTION_FONT = 7.2;
const LABEL_LINE = 10.6;
const DESCRIPTION_LINE = 9;
const LABEL_CHAR = 4.6;
const DESCRIPTION_CHAR = 3.8;
const PADDING_X = 10;
const PADDING_Y = 9;
const MAX_NODE_WIDTH = 340;
const MIN_NODE_WIDTH = 92;
const ROW_GAP = 16;
const LAYER_GAP = 30;
const STACK_GAP = 12;
const EDGE_CHANNEL = 4;

/** Extra vertical room for shapes that draw outside their rectangle. */
const KIND_HEIGHT_FACTOR: Record<FlowchartKind, number> = {
  start: 1, process: 1, decision: 1.46, data: 1, document: 1.08, database: 1.14, end: 1
};

function charCapacity(width: number, unit: number): number {
  return Math.max(6, Math.floor(width / unit));
}

export function wrapFlowchartText(text: string, maxCharacters: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharacters || current === '') {
      // A single word longer than the line is hard-split instead of overflowing the box.
      if (candidate.length > maxCharacters && current === '') {
        let rest = candidate;
        while (rest.length > maxCharacters && lines.length < maxLines - 1) {
          lines.push(rest.slice(0, maxCharacters));
          rest = rest.slice(maxCharacters);
        }
        current = rest;
      } else {
        current = candidate;
      }
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === 0) return [];
  const consumed = lines.join(' ').length;
  if (consumed < text.trim().length) {
    const last = lines[lines.length - 1] ?? '';
    lines[lines.length - 1] = `${last.slice(0, Math.max(1, maxCharacters - 1)).trimEnd()}…`;
  }
  return lines;
}

/** Returns the indexes of edges that close a cycle; those are rendered as loops. */
export function cyclicFlowchartEdges(nodes: Array<{ id: string }>, edges: FlowchartEdgeInput[]): Set<number> {
  const adjacency = new Map<string, Array<{ to: string; index: number }>>();
  nodes.forEach((node) => adjacency.set(node.id, []));
  edges.forEach((edge, index) => {
    if (edge.from === edge.to) return;
    adjacency.get(edge.from)?.push({ to: edge.to, index });
  });
  const state = new Map<string, 0 | 1 | 2>();
  const cyclic = new Set<number>();
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const { to, index } of adjacency.get(id) ?? []) {
      const next = state.get(to) ?? 0;
      if (next === 1) cyclic.add(index);
      else if (next === 0) visit(to);
    }
    state.set(id, 2);
  };
  for (const node of nodes) if ((state.get(node.id) ?? 0) === 0) visit(node.id);
  return cyclic;
}

function assignLayers(nodes: FlowchartNodeInput[], edges: FlowchartEdgeInput[], cyclic: Set<number>): Map<string, number> {
  const layer = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    edges.forEach((edge, index) => {
      if (cyclic.has(index) || edge.from === edge.to) return;
      const from = layer.get(edge.from);
      const to = layer.get(edge.to);
      if (from === undefined || to === undefined) return;
      if (from + 1 > to) {
        layer.set(edge.to, from + 1);
        changed = true;
      }
    });
    if (!changed) break;
  }
  return layer;
}

interface NodeMetrics { width: number; height: number; labelLines: string[]; descriptionLines: string[]; textInset: number }

function measureNode(node: FlowchartNodeInput, width: number): NodeMetrics {
  const kind = node.kind ?? 'process';
  const decision = kind === 'decision';
  const textInset = decision ? Math.round(width * 0.17) : 0;
  const textWidth = Math.max(24, width - (PADDING_X + textInset) * 2);
  const labelLines = wrapFlowchartText(node.label, charCapacity(textWidth, LABEL_CHAR), decision ? 2 : 3);
  const descriptionLines = node.description ? wrapFlowchartText(node.description, charCapacity(textWidth, DESCRIPTION_CHAR), 3) : [];
  const content = labelLines.length * LABEL_LINE + (descriptionLines.length ? 4 + descriptionLines.length * DESCRIPTION_LINE : 0);
  const height = Math.max(34, content + PADDING_Y * 2) * (KIND_HEIGHT_FACTOR[kind] ?? 1);
  return { width, height, labelLines, descriptionLines, textInset };
}

function baselines(node: NodeMetrics): { label: number[]; description: number[] } {
  const content = node.labelLines.length * LABEL_LINE + (node.descriptionLines.length ? 4 + node.descriptionLines.length * DESCRIPTION_LINE : 0);
  let cursor = node.height / 2 - content / 2 + LABEL_FONT * 0.78;
  const label: number[] = [];
  for (let index = 0; index < node.labelLines.length; index += 1) {
    label.push(cursor);
    cursor += LABEL_LINE;
  }
  const description: number[] = [];
  if (node.descriptionLines.length) {
    cursor += 4 - LABEL_LINE + DESCRIPTION_FONT * 0.78;
    for (let index = 0; index < node.descriptionLines.length; index += 1) {
      description.push(cursor);
      cursor += DESCRIPTION_LINE;
    }
  }
  return { label, description };
}

function groupByLayer(nodes: FlowchartNodeInput[], layer: Map<string, number>): FlowchartNodeInput[][] {
  const buckets = new Map<number, FlowchartNodeInput[]>();
  for (const node of nodes) {
    const depth = layer.get(node.id) ?? 0;
    const bucket = buckets.get(depth);
    if (bucket) bucket.push(node);
    else buckets.set(depth, [node]);
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((depth) => buckets.get(depth) ?? []);
}

function verticalLayout(layers: FlowchartNodeInput[][], width: number): {
  placed: PositionedFlowchartNode[]; height: number; layerOf: Map<string, number>;
} {
  const placed: PositionedFlowchartNode[] = [];
  const layerOf = new Map<string, number>();
  let y = 0;
  layers.forEach((layerNodes, layerIndex) => {
    const count = layerNodes.length;
    const available = Math.max(MIN_NODE_WIDTH, width - ROW_GAP * (count - 1));
    const baseWidth = Math.max(MIN_NODE_WIDTH, Math.min(MAX_NODE_WIDTH, available / count));
    // A diamond that spans the whole row reads as a banner; keep decisions compact.
    const widths = layerNodes.map((node) => (node.kind === 'decision' ? Math.min(baseWidth, 220) : baseWidth));
    const metrics = layerNodes.map((node, index) => measureNode(node, widths[index] ?? baseWidth));
    const rowWidth = metrics.reduce((sum, metric) => sum + metric.width, 0) + ROW_GAP * (count - 1);
    const startX = (width - rowWidth) / 2;
    const rowHeight = Math.max(...metrics.map((metric) => metric.height));
    let cursorX = startX;
    metrics.forEach((metric, index) => {
      const node = layerNodes[index]!;
      const lines = baselines(metric);
      const x = cursorX;
      placed.push({
        ...node,
        x,
        y: y + (rowHeight - metric.height) / 2,
        width: metric.width,
        height: metric.height,
        labelLines: metric.labelLines,
        descriptionLines: metric.descriptionLines,
        textInset: metric.textInset,
        labelBaselines: lines.label,
        descriptionBaselines: lines.description
      });
      layerOf.set(node.id, layerIndex);
      cursorX += metric.width + ROW_GAP;
    });
    y += rowHeight + LAYER_GAP;
  });
  return { placed, height: Math.max(0, y - LAYER_GAP), layerOf };
}

function horizontalLayout(layers: FlowchartNodeInput[][], width: number): {
  placed: PositionedFlowchartNode[]; height: number; layerOf: Map<string, number>;
} {
  const placed: PositionedFlowchartNode[] = [];
  const layerOf = new Map<string, number>();
  const layerCount = Math.max(1, layers.length);
  const columnWidth = Math.max(MIN_NODE_WIDTH, Math.min(220, (width - ROW_GAP * (layerCount - 1)) / layerCount));
  const totalWidth = columnWidth * layerCount + ROW_GAP * (layerCount - 1);
  const offsetX = Math.max(0, (width - totalWidth) / 2);
  const heights: number[] = [];
  const columns = layers.map((layerNodes) => layerNodes.map((node) => measureNode(node, columnWidth)));
  columns.forEach((metrics) => {
    const stacked = metrics.reduce((sum, metric) => sum + metric.height, 0) + STACK_GAP * Math.max(0, metrics.length - 1);
    heights.push(stacked);
  });
  const totalHeight = Math.max(0, ...heights);
  layers.forEach((layerNodes, layerIndex) => {
    const metrics = columns[layerIndex] ?? [];
    let y = (totalHeight - (heights[layerIndex] ?? 0)) / 2;
    metrics.forEach((metric, index) => {
      const node = layerNodes[index]!;
      const lines = baselines(metric);
      placed.push({
        ...node,
        x: offsetX + layerIndex * (columnWidth + ROW_GAP),
        y,
        width: metric.width,
        height: metric.height,
        labelLines: metric.labelLines,
        descriptionLines: metric.descriptionLines,
        textInset: metric.textInset,
        labelBaselines: lines.label,
        descriptionBaselines: lines.description
      });
      layerOf.set(node.id, layerIndex);
      y += metric.height + STACK_GAP;
    });
  });
  return { placed, height: totalHeight, layerOf };
}

function routeEdges(
  edges: FlowchartEdgeInput[],
  placed: PositionedFlowchartNode[],
  layerOf: Map<string, number>,
  cyclic: Set<number>,
  direction: FlowchartDirection,
  width: number
): RoutedFlowchartEdge[] {
  const byId = new Map(placed.map((node) => [node.id, node]));
  const routed: RoutedFlowchartEdge[] = [];
  edges.forEach((edge, index) => {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) return;
    const sourceLayer = layerOf.get(source.id) ?? 0;
    const targetLayer = layerOf.get(target.id) ?? 0;
    const loop = cyclic.has(index) || targetLayer <= sourceLayer;
    if (direction === 'vertical') {
      if (loop) {
        const channelX = Math.max(source.x + source.width, target.x + target.width) + 12;
        const x = Math.min(width - EDGE_CHANNEL, channelX);
        const sourceY = source.y + source.height / 2;
        const targetY = target.y + target.height / 2;
        routed.push({
          ...edge, loop, arrow: 'left',
          points: [
            { x: source.x + source.width, y: sourceY },
            { x, y: sourceY },
            { x, y: targetY },
            { x: target.x + target.width, y: targetY }
          ],
          labelX: x + 2,
          labelY: (sourceY + targetY) / 2 - 4
        });
        return;
      }
      const sourceX = source.x + source.width / 2;
      const sourceY = source.y + source.height;
      const targetX = target.x + target.width / 2;
      const targetY = target.y;
      if (Math.abs(sourceX - targetX) < 0.5) {
        routed.push({
          ...edge, loop: false, arrow: 'down',
          points: [{ x: sourceX, y: sourceY }, { x: targetX, y: targetY }],
          labelX: sourceX + 6,
          labelY: (sourceY + targetY) / 2 + 2
        });
        return;
      }
      const midY = sourceY + Math.max(10, (targetY - sourceY) / 2);
      routed.push({
        ...edge, loop: false, arrow: 'down',
        points: [
          { x: sourceX, y: sourceY },
          { x: sourceX, y: midY },
          { x: targetX, y: midY },
          { x: targetX, y: targetY }
        ],
        labelX: (sourceX + targetX) / 2,
        labelY: midY - 4
      });
      return;
    }
    if (loop) {
      const channelY = Math.max(source.y + source.height, target.y + target.height) + 10;
      const y = channelY;
      const sourceX = source.x + source.width / 2;
      const targetX = target.x + target.width / 2;
      routed.push({
        ...edge, loop, arrow: 'up',
        points: [
          { x: sourceX, y: source.y + source.height },
          { x: sourceX, y },
          { x: targetX, y },
          { x: targetX, y: target.y + target.height }
        ],
        labelX: (sourceX + targetX) / 2,
        labelY: y + 7
      });
      return;
    }
    const sourceX = source.x + source.width;
    const sourceY = source.y + source.height / 2;
    const targetX = target.x;
    const targetY = target.y + target.height / 2;
    if (Math.abs(sourceY - targetY) < 0.5) {
      routed.push({
        ...edge, loop: false, arrow: 'right',
        points: [{ x: sourceX, y: sourceY }, { x: targetX, y: targetY }],
        labelX: (sourceX + targetX) / 2,
        labelY: sourceY - 4
      });
      return;
    }
    const midX = sourceX + Math.max(10, (targetX - sourceX) / 2);
    routed.push({
      ...edge, loop: false, arrow: 'right',
      points: [
        { x: sourceX, y: sourceY },
        { x: midX, y: sourceY },
        { x: midX, y: targetY },
        { x: targetX, y: targetY }
      ],
      labelX: midX,
      labelY: (sourceY + targetY) / 2 - 4
    });
  });
  return routed;
}

export function computeFlowchartLayout(options: FlowchartLayoutOptions): FlowchartLayoutResult {
  const width = Math.max(120, options.width);
  const cyclic = cyclicFlowchartEdges(options.nodes, options.edges);
  const layer = assignLayers(options.nodes, options.edges, cyclic);
  const layers = groupByLayer(options.nodes, layer);
  const { placed, height, layerOf } = options.direction === 'horizontal'
    ? horizontalLayout(layers, width)
    : verticalLayout(layers, width);
  return {
    width,
    height,
    nodes: placed,
    edges: routeEdges(options.edges, placed, layerOf, cyclic, options.direction, width)
  };
}

export const flowchartMetrics = { LABEL_FONT, DESCRIPTION_FONT, LABEL_LINE, DESCRIPTION_LINE } as const;
