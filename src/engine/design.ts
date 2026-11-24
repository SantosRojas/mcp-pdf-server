/**
 * Shared design tokens for the PDF renderer.
 *
 * Every hard-coded size, radius or spacing used to live inline in `render.tsx`, which
 * made the visual language drift between components. Centralising the scale keeps the
 * document coherent and gives the themes a single place to be tuned.
 */

/** 4pt-based spacing scale. */
export const SPACE = {
  xxs: 2,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 24,
  xxxl: 32
} as const;

export const RADIUS = {
  sm: 2,
  md: 3,
  lg: 5,
  pill: 999
} as const;

/** Typographic scale (pt). Body text stays at 10pt, the schema default. */
export const TYPE = {
  display: 23,
  h1: 14.5,
  h2: 12,
  h3: 10.5,
  body: 10,
  small: 9,
  caption: 8,
  micro: 7.5,
  tiny: 7
} as const;

export const LINE_HEIGHT = {
  tight: 1.15,
  normal: 1.35,
  relaxed: 1.45
} as const;

/** Letter spacing (pt). Tight tracking for display text, positive for small caps. */
export const TRACKING = {
  display: -0.4,
  heading: -0.1,
  normal: 0,
  wide: 0.2,
  caps: 0.55
} as const;

export interface SemanticColor {
  background: string;
  border: string;
  foreground: string;
}

function parseHex(hex: string): [number, number, number] | undefined {
  const value = hex.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(value);
  if (short) {
    const [r, g, b] = short[1]!.split('');
    return [parseInt(`${r}${r}`, 16), parseInt(`${g}${g}`, 16), parseInt(`${b}${b}`, 16)];
  }
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value);
  if (long) {
    const digits = long[1]!;
    return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
  }
  return undefined;
}

function toHex(channel: number): string {
  return Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0');
}

/** Adds opacity to a theme color so tints stay in sync with the palette. */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

/** Mixes two hex colors. `weight` is how much of `second` is used (0..1). */
export function mix(first: string, second: string, weight: number): string {
  const a = parseHex(first);
  const b = parseHex(second);
  if (!a || !b) return first;
  const ratio = Math.max(0, Math.min(1, weight));
  const channels = a.map((value, index) => value + (b[index]! - value) * ratio);
  return `#${toHex(channels[0]!)}${toHex(channels[1]!)}${toHex(channels[2]!)}`;
}

/** Relative luminance (WCAG) used to pick readable text on a solid background. */
export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White text on dark fills, near-black text on light fills (table headers, badges, chips). */
export function readableText(background: string): string {
  return luminance(background) > 0.55 ? '#17212F' : '#FFFFFF';
}

export function chartPalette(primary: string, accent: string): string[] {
  // Accent and primary come first so charts follow the document theme; the rest keep
  // categorical series distinguishable without relying on the palette alone.
  return [accent, primary, '#0F9D79', '#E59B22', '#8B5CF6', '#D14C67', '#0EA5E9'];
}

export function calloutPalette(primary: string, accent: string): Record<'info' | 'warning' | 'success' | 'danger', SemanticColor> {
  return {
    info: { background: withAlpha(accent, 0.09), border: accent, foreground: mix(primary, '#000000', 0.2) },
    warning: { background: '#FFFBEB', border: '#F59E0B', foreground: '#92400E' },
    success: { background: '#ECFDF5', border: '#34D399', foreground: '#065F46' },
    danger: { background: '#FEF2F2', border: '#F87171', foreground: '#991B1B' }
  };
}

export function flowchartPalette(primary: string, accent: string, text: string): Record<string, SemanticColor> {
  return {
    start: { background: withAlpha(accent, 0.1), border: accent, foreground: mix(accent, '#000000', 0.45) },
    end: { background: withAlpha(accent, 0.1), border: accent, foreground: mix(accent, '#000000', 0.45) },
    process: { background: withAlpha(primary, 0.04), border: mix(primary, '#FFFFFF', 0.55), foreground: text },
    decision: { background: '#FFFBEB', border: '#D97706', foreground: '#78350F' },
    data: { background: withAlpha(accent, 0.07), border: mix(accent, '#FFFFFF', 0.35), foreground: mix(accent, '#000000', 0.5) },
    document: { background: '#F5F3FF', border: '#8B5CF6', foreground: '#4C1D95' },
    database: { background: '#ECFDF5', border: '#10B981', foreground: '#064E3B' }
  };
}

/** Metric values shrink instead of overflowing their card. */
export function metricValueSize(value: string): number {
  const length = value.trim().length;
  if (length <= 9) return 21;
  if (length <= 13) return 18;
  if (length <= 18) return 15.5;
  return 13.5;
}
