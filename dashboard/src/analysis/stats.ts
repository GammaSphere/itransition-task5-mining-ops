export interface Summary {
  n: number;
  sum: number;
  mean: number;
  sd: number;
  median: number;
  q1: number;
  q3: number;
  iqr: number;
  min: number;
  max: number;
  cv: number;
}

export const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

export const mean = (xs: readonly number[]) => (xs.length ? sum(xs) / xs.length : NaN);

/** Sample standard deviation (n - 1). */
export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Quantile with linear interpolation between order statistics (type 7: Excel QUARTILE.INC, NumPy default). */
export function quantile(xs: readonly number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

export const median = (xs: readonly number[]) => quantile(xs, 0.5);

export function summarize(xs: readonly number[]): Summary {
  const q1 = quantile(xs, 0.25);
  const q3 = quantile(xs, 0.75);
  const m = mean(xs);
  const s = sd(xs);
  return {
    n: xs.length,
    sum: sum(xs),
    mean: m,
    sd: s,
    median: median(xs),
    q1,
    q3,
    iqr: q3 - q1,
    min: Math.min(...xs),
    max: Math.max(...xs),
    cv: m ? s / m : NaN,
  };
}
