const MS_PER_DAY = 86400000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/** Calendar date → Excel serial number (inverse of `serialToYmd`). */
export function serialFromYmd(y: number, m: number, d: number, date1904: boolean): number {
  const base = date1904 ? EPOCH_1904 : EPOCH_1900;
  return Math.round((Date.UTC(y, m - 1, d) - base) / MS_PER_DAY);
}
