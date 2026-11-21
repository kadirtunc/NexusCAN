export interface RichSegment {
  text: string;
  code: boolean;
}

/** Splits `plain `code` plain` into segments; backtick spans are rendered mono + tabular-nums. */
export function splitInlineCode(input: string): RichSegment[] {
  const out: RichSegment[] = [];
  const parts = input.split('`');
  parts.forEach((p, i) => {
    if (p.length > 0) out.push({ text: p, code: i % 2 === 1 });
  });
  return out;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function inlineCodeToHtml(input: string): string {
  return splitInlineCode(input)
    .map((s) =>
      s.code ? `<code class="nx-code">${escapeHtml(s.text)}</code>` : escapeHtml(s.text),
    )
    .join('');
}
