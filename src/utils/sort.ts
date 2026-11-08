/** Plain code-unit order: the same result on every machine, whatever its locale. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
