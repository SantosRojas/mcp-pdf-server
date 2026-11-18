import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Font } from '@react-pdf/renderer';
import { config } from '../config.js';
import type { GeneratePdfInput } from '../schemas/ast.js';

export interface ThemeTokens {
  primary: string; accent: string; text: string; muted: string; border: string;
  surface: string; font: string; mono: string;
}

const presets: Record<string, Omit<ThemeTokens, 'font' | 'mono'>> = {
  corporate_blue: { primary: '#173B67', accent: '#2F75B5', text: '#17212F', muted: '#65758B', border: '#D8E0EA', surface: '#F3F6FA' },
  modern_minimal: { primary: '#20252B', accent: '#4B6478', text: '#20252B', muted: '#6B7280', border: '#E5E7EB', surface: '#F8FAFC' },
  executive_dark: { primary: '#1F2937', accent: '#A78BFA', text: '#202938', muted: '#667085', border: '#D9DCE2', surface: '#F6F5FA' },
  financial_classic: { primary: '#173D2B', accent: '#557A62', text: '#1F2923', muted: '#65736B', border: '#D8E2DA', surface: '#F4F7F4' },
  technical_docs: { primary: '#263238', accent: '#00796B', text: '#263238', muted: '#607D8B', border: '#CFD8DC', surface: '#F4F7F8' }
};

interface FontFace { file: string; fontWeight: 400 | 600 | 700; fontStyle: 'normal' | 'italic' }

// Every face is optional: the server must keep working with only the PDF base fonts.
// Registering italic/semibold faces when present avoids falling back to a faux style.
const fontFamilies: Array<{ family: string; faces: FontFace[] }> = [
  {
    family: 'Inter',
    faces: [
      { file: 'Inter-Regular.ttf', fontWeight: 400, fontStyle: 'normal' },
      { file: 'Inter-Italic.ttf', fontWeight: 400, fontStyle: 'italic' },
      { file: 'Inter-SemiBold.ttf', fontWeight: 600, fontStyle: 'normal' },
      { file: 'Inter-Bold.ttf', fontWeight: 700, fontStyle: 'normal' },
      { file: 'Inter-BoldItalic.ttf', fontWeight: 700, fontStyle: 'italic' }
    ]
  },
  {
    family: 'Roboto',
    faces: [
      { file: 'Roboto-Regular.ttf', fontWeight: 400, fontStyle: 'normal' },
      { file: 'Roboto-Italic.ttf', fontWeight: 400, fontStyle: 'italic' },
      { file: 'Roboto-Medium.ttf', fontWeight: 600, fontStyle: 'normal' },
      { file: 'Roboto-Bold.ttf', fontWeight: 700, fontStyle: 'normal' }
    ]
  },
  {
    family: 'JetBrainsMono',
    faces: [
      { file: 'JetBrainsMono-Regular.ttf', fontWeight: 400, fontStyle: 'normal' },
      { file: 'JetBrainsMono-Italic.ttf', fontWeight: 400, fontStyle: 'italic' },
      { file: 'JetBrainsMono-Bold.ttf', fontWeight: 700, fontStyle: 'normal' }
    ]
  }
];

let fontRegistrationPromise: Promise<void> | undefined;
const registeredFonts = new Set<string>();
const registeredFaces = new Map<string, Array<{ file: string; fontWeight: number; fontStyle: string }>>();

export function registerOptionalFonts(): Promise<void> {
  if (fontRegistrationPromise) return fontRegistrationPromise;
  const pending = (async () => {
    for (const definition of fontFamilies) {
      const available: Array<{ src: string; fontWeight: 400 | 600 | 700; fontStyle: 'normal' | 'italic' }> = [];
      for (const face of definition.faces) {
        const fontPath = path.join(config.fontDir, face.file);
        try {
          await fs.access(fontPath);
          available.push({ src: fontPath, fontWeight: face.fontWeight, fontStyle: face.fontStyle });
        } catch { /* optional face */ }
      }
      if (available.length === 0) continue;
      if (!available.some((face) => face.fontWeight === 400 && face.fontStyle === 'normal')) continue;
      Font.register({ family: definition.family, fonts: available });
      registeredFonts.add(definition.family);
      registeredFaces.set(definition.family, available.map((face) => ({ file: path.basename(face.src), fontWeight: face.fontWeight, fontStyle: face.fontStyle })));
    }
  })();
  fontRegistrationPromise = pending;
  return pending;
}

export function isFontFamilyAvailable(family: string): boolean {
  if (family === 'Helvetica' || family === 'Times-Roman' || family === 'Courier') return true;
  return registeredFonts.has(family);
}

export function describeRegisteredFonts(): Array<{ family: string; faces: Array<{ file: string; fontWeight: number; fontStyle: string }> }> {
  return [...registeredFaces.entries()].map(([family, faces]) => ({ family, faces }));
}

export function resolveTheme(input: GeneratePdfInput['theme']): ThemeTokens {
  const base = presets[input.preset] ?? presets.corporate_blue!;
  const requestedFont = input.fontFamily;
  const font = isFontFamilyAvailable(requestedFont) ? requestedFont : 'Helvetica';
  return {
    ...base,
    primary: input.primaryColor ?? base.primary,
    accent: input.accentColor ?? base.accent,
    muted: input.mutedColor ?? base.muted,
    font,
    mono: registeredFonts.has('JetBrainsMono') ? 'JetBrainsMono' : 'Courier'
  };
}
