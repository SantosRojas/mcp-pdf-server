// Inline markup shared across Text, Callout, BulletList, DataTable text cells, KeyValueList,
// DocumentHeader subtitles, and InvoiceSummary notes.
//
// Supported: **bold**, `code`, *italic*, _italic_, and [label](https://...) / [label](mailto:...).
// Underscore emphasis follows CommonMark: a delimiter touching a letter or digit stays literal
// so identifiers such as EN_COLA or FINALIZADO_OK survive untouched.

export type InlineRunKind = 'text' | 'bold' | 'code' | 'italic' | 'link';
export interface InlineRun {
  kind: InlineRunKind;
  text: string;
  href?: string;
}

const INLINE_PATTERN = /(\[[^\]\n]+\]\((?:https?:\/\/|mailto:|#)[^\s)]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`|(?<!\*)\*[^*\s][^*\n]*?(?<!\s)\*(?!\*)|(?<!\*)\*[^*\s]\*(?!\*)|(?<![\p{L}\p{N}_])_[^_\n]+_(?![\p{L}\p{N}_]))/gu;
const LINK_MATCH = /^\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:|#)[^\s)]+)\)$/;

export function splitInlineMarkup(input: string): InlineRun[] {
  const parts = input.split(INLINE_PATTERN).filter((part) => part.length > 0);
  return parts.map((part): InlineRun => {
    const link = part.match(LINK_MATCH);
    if (link) return { kind: 'link', text: link[1]!, href: link[2]! };
    if (part.length >= 4 && part.startsWith('**') && part.endsWith('**')) return { kind: 'bold', text: part.slice(2, -2) };
    if (part.length >= 3 && part.startsWith('`') && part.endsWith('`')) return { kind: 'code', text: part.slice(1, -1) };
    if (part.length >= 3 && part.startsWith('*') && part.endsWith('*')) return { kind: 'italic', text: part.slice(1, -1) };
    if (part.length >= 3 && part.startsWith('_') && part.endsWith('_')) return { kind: 'italic', text: part.slice(1, -1) };
    return { kind: 'text', text: part };
  });
}
