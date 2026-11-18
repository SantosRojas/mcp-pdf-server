// Inline markup shared by Text, Callout and BulletList.
//
// Supported: **bold**, `code` and _italic_. Underscore emphasis follows CommonMark:
// a delimiter that touches a letter or digit is literal, so identifiers such as
// EN_COLA or FINALIZADO_OK survive untouched inside prose and diagram labels.

export type InlineRunKind = 'text' | 'bold' | 'code' | 'italic';
export interface InlineRun { kind: InlineRunKind; text: string }

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|(?<![\p{L}\p{N}_])_[^_\n]+_(?![\p{L}\p{N}_]))/gu;

export function splitInlineMarkup(input: string): InlineRun[] {
  const parts = input.split(INLINE_PATTERN).filter((part) => part.length > 0);
  return parts.map((part) => {
    if (part.length >= 4 && part.startsWith('**') && part.endsWith('**')) return { kind: 'bold', text: part.slice(2, -2) } satisfies InlineRun;
    if (part.length >= 3 && part.startsWith('`') && part.endsWith('`')) return { kind: 'code', text: part.slice(1, -1) } satisfies InlineRun;
    if (part.length >= 3 && part.startsWith('_') && part.endsWith('_')) return { kind: 'italic', text: part.slice(1, -1) } satisfies InlineRun;
    return { kind: 'text', text: part } satisfies InlineRun;
  });
}
