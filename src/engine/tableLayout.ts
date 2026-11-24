/**
 * A table that fits on an empty page can still leave a large gap when it does
 * not fit in the space left on the current page. Allowing large tables to break
 * between rows (with a repeated header) fills the page instead of jumping whole
 * to the next one. Small tables stay whole because splitting them looks worse
 * than the gap.
 */
export const MIN_SPLIT_ROWS = 5;

export function shouldSplitTable(rowCount: number, fitsOnOnePage: boolean): boolean {
  return !fitsOnOnePage || rowCount >= MIN_SPLIT_ROWS;
}
