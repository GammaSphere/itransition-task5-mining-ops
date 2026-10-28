export interface PolyFit {
  degree: number;
  /** Coefficients in the scaled variable u = 2i/(n-1) - 1, lowest power first. */
  coef: number[];
  fitted: number[];
  r2: number;
  at(i: number): number;
}

/** Day index scaled to [-1, 1] so the normal equations stay well conditioned up to degree 4. */
export const scaleIndex = (i: number, n: number) => (n > 1 ? (2 * i) / (n - 1) - 1 : 0);

/** Weighted least squares for a design matrix X (rows = observations). */
export function lstsq(X: readonly number[][], y: readonly number[], weights?: readonly number[]): number[] {
  const k = X[0]?.length ?? 0;
  const ata = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const aty = new Array<number>(k).fill(0);
  X.forEach((row, i) => {
    const w = weights ? weights[i] : 1;
    for (let r = 0; r < k; r++) {
      aty[r] += w * row[r] * y[i];
      for (let c = 0; c < k; c++) ata[r][c] += w * row[r] * row[c];
    }
  });
  return solve(ata, aty);
}

/** Iteratively reweighted least squares with Tukey's bisquare weights (c = 4.685 robust SDs). */
export function robustLstsq(X: readonly number[][], y: readonly number[], iterations = 8): { coef: number[]; weights: number[] } {
  let weights = y.map(() => 1);
  let coef = lstsq(X, y);
  for (let it = 0; it < iterations; it++) {
    const res = y.map((v, i) => v - dot(X[i], coef));
    const abs = res.map(Math.abs).sort((a, b) => a - b);
    const mad = abs[Math.floor(abs.length / 2)] * 1.4826;
    if (!(mad > 1e-12)) break;
    weights = res.map((r) => {
      const u = r / (4.685 * mad);
      // Floor > 0: a column (e.g. one weekday) whose days are all outliers must not drop out of the fit.
      return Math.max(1e-3, Math.abs(u) < 1 ? (1 - u * u) ** 2 : 0);
    });
    coef = lstsq(X, y, weights);
  }
  return { coef, weights };
}

export const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

export const powers = (u: number, degree: number) => Array.from({ length: degree + 1 }, (_, j) => u ** j);

/** Least-squares polynomial trend of y against the day index i = 0..n-1 (the chart trendline). */
export function polyfit(y: readonly number[], degree: number): PolyFit {
  const n = y.length;
  const d = Math.max(0, Math.min(degree, n - 1));
  const coef = lstsq(y.map((_, i) => powers(scaleIndex(i, n), d)), y);
  const at = (i: number) => dot(powers(scaleIndex(i, n), d), coef);
  const fitted = y.map((_, i) => at(i));
  const m = y.reduce((a, b) => a + b, 0) / (n || 1);
  const ssTot = y.reduce((a, v) => a + (v - m) ** 2, 0);
  const ssRes = y.reduce((a, v, i) => a + (v - fitted[i]) ** 2, 0);
  return { degree: d, coef, fitted, r2: ssTot ? 1 - ssRes / ssTot : 1, at };
}

/** Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    [m[col], m[piv]] = [m[piv], m[col]];
    const p = m[col][col];
    if (Math.abs(p) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / p;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}
