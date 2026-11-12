/**
 * CSV formula-injection guard (MED-09): spreadsheet apps evaluate cells that start with
 * `=`, `+`, `-`, `@`, TAB or CR. Such cells get a leading `'` so they are shown as text.
 * Apply to TEXT cells only (symbol names, decoded strings, headers); never to plain numbers.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvSafeText(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

/** Quote + escape a text cell, neutralizing formula prefixes first. */
export function csvQuote(value: string): string {
  return `"${csvSafeText(value).replace(/"/g, '""')}"`;
}
