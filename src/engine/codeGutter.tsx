import React from 'react';
import { Svg, Path } from '@react-pdf/renderer';
import { CODE_LINE_HEIGHT, GUTTER_RIGHT_PADDING } from './codeMetrics.js';

/**
 * Line-number gutter drawn as vector geometry instead of text.
 *
 * This is the whole point of the component: a PDF has no way to mark text as "not part of
 * the selection", so every character rendered with <Text> ends up in the copy buffer. Drawing
 * the numbers as stroke paths keeps them perfectly visible while leaving the text layer with
 * nothing but the source code, which is what readers actually want when they paste into an IDE.
 */

/** Glyph box: single-stroke digits, y grows downwards. */
const GLYPH_WIDTH = 3.4;
const GLYPH_HEIGHT = 6;
const ADVANCE = 4.3;
/** Cap height relative to the font size (monospace digits sit around 0.62em). */
const CAP_HEIGHT_RATIO = 0.62;

type Segment = [command: 'M' | 'L' | 'Q' | 'Z', ...points: number[]];
type SubPath = Segment[];

const DIGIT_GLYPHS: Record<string, SubPath[]> = {
  '0': [[['M', 1.05, 0], ['L', 2.35, 0], ['Q', 3.4, 0, 3.4, 1.25], ['L', 3.4, 4.75], ['Q', 3.4, 6, 2.35, 6], ['L', 1.05, 6], ['Q', 0, 6, 0, 4.75], ['L', 0, 1.25], ['Q', 0, 0, 1.05, 0], ['Z']]],
  '1': [
    [['M', 0.55, 1.55], ['L', 1.85, 0.25], ['L', 1.85, 6]],
    [['M', 0.45, 6], ['L', 3.25, 6]]
  ],
  '2': [[['M', 0.15, 1.35], ['Q', 0.5, 0, 1.7, 0], ['Q', 3.3, 0, 3.3, 1.7], ['Q', 3.3, 2.75, 2.15, 3.7], ['L', 0.1, 6], ['L', 3.4, 6]]],
  '3': [
    [['M', 0.2, 0.55], ['Q', 0.85, 0, 1.75, 0], ['Q', 3.3, 0, 3.3, 1.55], ['Q', 3.3, 3, 1.7, 3]],
    [['M', 1.7, 3], ['Q', 3.4, 3, 3.4, 4.55], ['Q', 3.4, 6, 1.75, 6], ['Q', 0.85, 6, 0.2, 5.5]]
  ],
  '4': [[['M', 2.6, 6], ['L', 2.6, 0], ['L', 0.1, 4.35], ['L', 3.4, 4.35]]],
  '5': [[['M', 3.15, 0], ['L', 0.55, 0], ['L', 0.35, 2.7], ['Q', 0.95, 2.3, 1.75, 2.3], ['Q', 3.4, 2.3, 3.4, 4.15], ['Q', 3.4, 6, 1.7, 6], ['Q', 0.8, 6, 0.2, 5.5]]],
  '6': [[['M', 3.1, 0.45], ['Q', 2.5, 0, 1.75, 0], ['Q', 0.1, 0, 0.1, 2.95], ['Q', 0.1, 6, 1.8, 6], ['Q', 3.35, 6, 3.35, 4.3], ['Q', 3.35, 2.65, 1.8, 2.65], ['Q', 0.55, 2.65, 0.1, 3.35]]],
  '7': [[['M', 0.15, 0], ['L', 3.4, 0], ['L', 1.3, 6]]],
  '8': [[['M', 1.7, 3], ['Q', 0.1, 3, 0.1, 1.5], ['Q', 0.1, 0, 1.7, 0], ['Q', 3.3, 0, 3.3, 1.5], ['Q', 3.3, 3, 1.7, 3], ['Q', 0.1, 3, 0.1, 4.5], ['Q', 0.1, 6, 1.7, 6], ['Q', 3.3, 6, 3.3, 4.5], ['Q', 3.3, 3, 1.7, 3]]],
  '9': [
    [['M', 1.7, 2.95], ['Q', 0.15, 2.95, 0.15, 1.5], ['Q', 0.15, 0, 1.7, 0], ['Q', 3.3, 0, 3.3, 1.5], ['Q', 3.3, 2.95, 1.7, 2.95]],
    [['M', 3.3, 2.95], ['L', 3.3, 4.65], ['Q', 3.3, 6, 1.55, 6]]
  ]
};

/** Marker shown on wrapped rows instead of a line number (a small right-then-down arrow). */
const CONTINUATION_GLYPH: SubPath[] = [
  [['M', 0.5, 1], ['L', 0.5, 3.1], ['Q', 0.5, 4.3, 1.7, 4.3], ['L', 2.9, 4.3]],
  [['M', 2.1, 3.5], ['L', 2.9, 4.3], ['L', 2.1, 5.1]]
];

export type GutterValue = number | 'continuation';

export interface GutterGeometry {
  width: number;
  height: number;
  strokeWidth: number;
  d: string;
}

function format(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function serialize(subPaths: SubPath[], offsetX: number, offsetY: number, scale: number): string {
  const commands: string[] = [];
  for (const segments of subPaths) {
    for (const [command, ...points] of segments) {
      if (command === 'Z') {
        commands.push('Z');
        continue;
      }
      const coordinates: string[] = [];
      for (let index = 0; index < points.length; index += 2) {
        coordinates.push(format(offsetX + (points[index] ?? 0) * scale), format(offsetY + (points[index + 1] ?? 0) * scale));
      }
      commands.push(`${command}${coordinates.join(' ')}`);
    }
  }
  return commands.join(' ');
}

/**
 * Builds the geometry for one gutter cell: the line number, or the arrow that marks a
 * wrapped row. Everything is expressed in points relative to the gutter box.
 */
export function computeGutterGeometry(value: GutterValue, gutterWidth: number, fontSize: number): GutterGeometry {
  const height = fontSize * CODE_LINE_HEIGHT;
  const scale = (fontSize * CAP_HEIGHT_RATIO) / GLYPH_HEIGHT;
  const inkWidth = GLYPH_WIDTH * scale;
  const advance = ADVANCE * scale;
  const offsetY = (height - GLYPH_HEIGHT * scale) / 2;
  const glyphs = value === 'continuation' ? [CONTINUATION_GLYPH] : String(Math.max(0, Math.trunc(value))).split('').map((digit) => DIGIT_GLYPHS[digit] ?? []);
  const rightEdge = gutterWidth - GUTTER_RIGHT_PADDING;
  const lastGlyphX = rightEdge - inkWidth;
  const firstGlyphX = lastGlyphX - (glyphs.length - 1) * advance;
  const d = glyphs.map((glyph, index) => serialize(glyph, firstGlyphX + index * advance, offsetY, scale)).join(' ');
  return { width: gutterWidth, height, strokeWidth: Math.max(0.42, fontSize * 0.085), d };
}

export interface CodeGutterProps {
  lineNumber: number;
  continuation: boolean;
  width: number;
  fontSize: number;
  color: string;
}

export function CodeGutter({ lineNumber, continuation, width, fontSize, color }: CodeGutterProps): React.ReactElement {
  const geometry = computeGutterGeometry(continuation ? 'continuation' : lineNumber, width, fontSize);
  return (
    <Svg width={geometry.width} height={geometry.height} viewBox={`0 0 ${geometry.width} ${geometry.height}`}>
      <Path d={geometry.d} stroke={color} strokeWidth={geometry.strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
