import { dot, polyfit, powers, robustLstsq, scaleIndex, type PolyFit } from "./regression";
import { mean, median, quantile, sd, summarize, type Summary } from "./stats";
import { grubbsCritical } from "./tdist";

export type TestId = "iqr" | "z" | "ma" | "grubbs";
export const TESTS: { id: TestId; name: string; short: string }[] = [
  { id: "iqr", name: "IQR rule", short: "IQR" },
  { id: "z", name: "Z-score", short: "Z" },
  { id: "ma", name: "Distance from moving average", short: "MA" },
  { id: "grubbs", name: "Grubbs' test", short: "G" },
];

export interface DetectionSettings {
  iqrK: number;
  zThreshold: number;
  /** Use median and MAD instead of mean and standard deviation (modified z-score). */
  zRobust: boolean;
  maWindow: number;
  maPct: number;
  maMode: "trailing" | "centered";
  grubbsAlpha: number;
  /** Upper bound r of the generalized (Rosner) Grubbs procedure; 1 = the classic single-outlier test. */
  grubbsMax: number;
  /** Test residuals from the trend instead of raw values. */
  detrend: boolean;
  /** Divide out the estimated day-of-week profile first. */
  seasonal: boolean;
  /** Polynomial degree of the trend (shared with the chart trendline). */
  degree: number;
  /** A day is an anomaly when at least this many tests flag it. */
  minTests: number;
}

export const DEFAULT_DETECTION: DetectionSettings = {
  iqrK: 1.5,
  zThreshold: 2.5,
  zRobust: false,
  maWindow: 7,
  maPct: 30,
  maMode: "trailing",
  grubbsAlpha: 0.05,
  grubbsMax: 10,
  detrend: true,
  seasonal: true,
  degree: 2,
  minTests: 2,
};

export interface Flag {
  test: TestId;
  dir: 1 | -1;
  /** Test statistic: IQR distance beyond the fence, z, relative MA distance, Grubbs G. */
  score: number;
}

export interface SeriesAnalysis {
  name: string;
  values: number[];
  summary: Summary;
  /** Trendline of the raw values (for charts). */
  trend: PolyFit;
  /** Day-of-week index, Monday first (1 = average day). */
  weekday: number[];
  /** Expected level = baseline trend x weekday index, in output units. */
  expected: number[];
  /** Values the IQR, z-score and Grubbs tests run on. */
  basis: number[];
  basisLabel: string;
  /** Seasonally adjusted values (the moving-average test runs on these). */
  adjusted: number[];
  /** Weekday index of each day (adjusted = values / dayIndex). */
  dayIndex: number[];
  ma: (number | null)[];
  fences: { lo: number; hi: number };
  zStats: { mean: number; sd: number };
  grubbsCrit: number;
  /** Normal range (IQR fences mapped back to output units). */
  bandLo: number[];
  bandHi: number[];
  flags: Flag[][];
  anomalies: number[];
  counts: Record<TestId, number>;
}

export interface GeneratorEvent {
  id: number;
  day: string;
  duration: number;
  factor: number;
  probability: number | null;
  mines: number | null;
  shape: string;
  affected: string[];
}

export interface Episode {
  id: number;
  series: string;
  dir: 1 | -1;
  start: number;
  end: number;
  peak: number;
  points: number[];
  tests: TestId[];
  peakValue: number;
  peakExpected: number;
  peakDevPct: number;
  match: GeneratorEvent | null;
}

/** ISO weekday index, Monday = 0. */
export const weekdayOf = (iso: string) => (new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7;

export function movingAverage(xs: readonly number[], window: number, mode: "trailing" | "centered"): (number | null)[] {
  const w = Math.max(2, Math.round(window));
  const need = Math.ceil(w / 2);
  return xs.map((_, i) => {
    let lo: number, hi: number;
    if (mode === "trailing") {
      lo = i - w;
      hi = i - 1;
    } else {
      lo = i - Math.floor(w / 2);
      hi = i + Math.floor(w / 2);
    }
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, lo); j <= Math.min(xs.length - 1, hi); j++) {
      if (j === i) continue; // the tested day never dilutes its own reference
      s += xs[j];
      c++;
    }
    return c >= need ? s / c : null;
  });
}

/**
 * Expected level: robust regression of log(output) on a polynomial trend and day-of-week dummies.
 * Output is multiplicative (base x weekday x trend x events), i.e. additive in logs, and Tukey
 * bisquare weights give anomalous days almost no influence on the fit.
 */
export function estimateBaseline(dates: readonly string[], y: readonly number[], s: Pick<DetectionSettings, "seasonal" | "detrend" | "degree">) {
  const n = y.length;
  const floor = Math.max(1e-6, median(y) * 0.01);
  const z = y.map((v) => Math.log(Math.max(v, floor)));
  const wds = dates.map(weekdayOf);
  const present = [...new Set(wds)].sort((a, b) => a - b);
  // A weekly profile needs at least two of each weekday; keep >= 6 residual degrees of freedom.
  const dummies = s.seasonal && n >= 14 ? present.slice(1) : [];
  const d = s.detrend ? Math.max(0, Math.min(s.degree, n - dummies.length - 7)) : 0;
  const X = y.map((_, i) => [...powers(scaleIndex(i, n), d), ...dummies.map((w) => (wds[i] === w ? 1 : 0))]);
  const { coef } = robustLstsq(X, z);
  const raw = new Array<number>(7).fill(1);
  dummies.forEach((w, k) => (raw[w] = Math.exp(coef[d + 1 + k])));
  const norm = mean(present.map((w) => raw[w]));
  const weekday = raw.map((v, w) => (present.includes(w) ? v / norm : 1));
  const trendCoef = coef.slice(0, d + 1);
  const level = y.map((_, i) => Math.exp(dot(powers(scaleIndex(i, n), d), trendCoef)) * norm);
  return { level, weekday };
}

/**
 * Grubbs' test generalized to up to r outliers (Rosner's generalized ESD). Each round removes the most
 * extreme value; the number of outliers is the largest round whose statistic G exceeds its critical value,
 * so a cluster of anomalies cannot mask itself. With r = 1 this is exactly the classic Grubbs test.
 */
/** Average daily growth of the underlying level (log-linear robust fit with weekday effects). */
export function growthRate(dates: readonly string[], y: readonly number[]): number {
  if (y.length < 3) return 0;
  const { level } = estimateBaseline(dates, y, { seasonal: true, detrend: true, degree: 1 });
  return Math.pow(level[level.length - 1] / level[0], 1 / (level.length - 1)) - 1;
}

export function grubbs(xs: readonly number[], alpha: number, maxOut: number) {
  const idx = xs.map((_, i) => i);
  const rounds: { i: number; g: number; crit: number }[] = [];
  const r = Math.max(1, Math.min(Math.round(maxOut), xs.length - 3));
  for (let k = 0; k < r && idx.length > 3; k++) {
    const vals = idx.map((i) => xs[i]);
    const m = mean(vals);
    const s = sd(vals);
    if (!(s > 0)) break;
    let best = 0;
    for (let j = 1; j < idx.length; j++) if (Math.abs(xs[idx[j]] - m) > Math.abs(xs[idx[best]] - m)) best = j;
    rounds.push({ i: idx[best], g: Math.abs(xs[idx[best]] - m) / s, crit: grubbsCritical(idx.length, alpha) });
    idx.splice(best, 1);
  }
  let count = 0;
  rounds.forEach((rd, k) => {
    if (rd.g > rd.crit) count = k + 1;
  });
  return { outliers: rounds.slice(0, count), crit: rounds[0]?.crit ?? grubbsCritical(Math.max(xs.length, 3), alpha) };
}

export function analyzeSeries(name: string, dates: readonly string[], values: readonly number[], s: DetectionSettings): SeriesAnalysis {
  const n = values.length;
  const y = [...values];
  const trend = polyfit(y, s.degree);

  // Raw mode tests the values themselves. Otherwise the tests run on the relative deviation from the
  // expected level, which keeps the spread constant while output grows and removes the weekly cycle.
  const raw = !s.detrend && !s.seasonal;
  const { level, weekday } = raw ? { level: new Array<number>(n).fill(median(y)), weekday: new Array<number>(7).fill(1) } : estimateBaseline(dates, y, s);
  const wd = dates.map((d) => weekday[weekdayOf(d)]);
  const adjusted = y.map((v, i) => v / wd[i]);
  const expected = level.map((l, i) => l * wd[i]);
  // Snap floating-point noise to zero so a perfectly regular series has nothing to flag.
  const basis = raw ? y : y.map((v, i) => (Math.abs(v / expected[i] - 1) < 1e-9 ? 0 : v / expected[i] - 1));
  const basisLabel = raw ? "daily output" : "relative deviation from expected";
  const toUnits = (b: number, i: number) => (raw ? b : (1 + b) * expected[i]);

  const flags: Flag[][] = y.map(() => []);
  // A flag needs a material effect: at least 1 % and 0.01 t away from the expected level
  // (the generator rounds to 0.01 t, so smaller gaps are rounding, not anomalies).
  const center = raw ? median(y) : 0;
  const material = (i: number) => {
    const ref = raw ? center : expected[i];
    return Math.abs(y[i] - ref) >= Math.max(0.01, 0.01 * Math.abs(ref));
  };

  // IQR rule
  const q1 = quantile(basis, 0.25);
  const q3 = quantile(basis, 0.75);
  const iqr = q3 - q1;
  const fences = { lo: q1 - s.iqrK * iqr, hi: q3 + s.iqrK * iqr };
  basis.forEach((b, i) => {
    if (!material(i)) return;
    if (iqr > 0 && b < fences.lo) flags[i].push({ test: "iqr", dir: -1, score: (fences.lo - b) / iqr });
    else if (iqr > 0 && b > fences.hi) flags[i].push({ test: "iqr", dir: 1, score: (b - fences.hi) / iqr });
  });

  // z-score
  const zm = s.zRobust ? median(basis) : mean(basis);
  const zs = s.zRobust ? 1.4826 * median(basis.map((b) => Math.abs(b - zm))) : sd(basis);
  basis.forEach((b, i) => {
    const z = zs > 0 ? (b - zm) / zs : 0;
    if (material(i) && Math.abs(z) > s.zThreshold) flags[i].push({ test: "z", dir: z > 0 ? 1 : -1, score: z });
  });

  // Distance (percent) from moving average
  const ma = movingAverage(adjusted, s.maWindow, s.maMode);
  adjusted.forEach((a, i) => {
    const m = ma[i];
    if (m === null || !(m > 0)) return;
    const dev = (a - m) / m;
    if (Math.abs(dev) * 100 > s.maPct) flags[i].push({ test: "ma", dir: dev > 0 ? 1 : -1, score: dev });
  });

  // Grubbs' test (iterative, two-sided)
  const g = grubbs(basis, s.grubbsAlpha, s.grubbsMax);
  for (const o of g.outliers) if (material(o.i)) flags[o.i].push({ test: "grubbs", dir: basis[o.i] > zm ? 1 : -1, score: o.g });

  const counts = { iqr: 0, z: 0, ma: 0, grubbs: 0 } as Record<TestId, number>;
  flags.forEach((f) => f.forEach((x) => counts[x.test]++));
  const anomalies = flags.map((f, i) => (f.length >= s.minTests ? i : -1)).filter((i) => i >= 0);

  return {
    name,
    values: y,
    summary: summarize(y),
    trend,
    weekday,
    expected,
    basis,
    basisLabel,
    adjusted,
    dayIndex: wd,
    ma,
    fences,
    zStats: { mean: zm, sd: zs },
    grubbsCrit: g.crit,
    bandLo: basis.map((_, i) => Math.max(0, toUnits(fences.lo, i))),
    bandHi: basis.map((_, i) => toUnits(fences.hi, i)),
    flags,
    anomalies,
    counts,
  };
}

/** Direction of an anomalous day: the majority of its flags, ties broken by the deviation from expected. */
export function directionOf(a: SeriesAnalysis, i: number): 1 | -1 {
  const sum = a.flags[i].reduce((acc, f) => acc + f.dir, 0);
  if (sum !== 0) return sum > 0 ? 1 : -1;
  return a.values[i] >= a.expected[i] ? 1 : -1;
}

const DAY = 86400000;
const toTime = (iso: string) => Date.parse(iso + "T00:00:00Z");

/** Days on which a configured generator event has a noticeable effect (bell weight >= 0.1). */
export function eventWindow(ev: GeneratorEvent): [number, number] {
  const start = toTime(ev.day);
  const dur = Math.max(1, ev.duration || 1);
  // The generator applies a Flat event while day < start + duration.
  if (ev.shape === "Flat") return [start, start + (Math.ceil(dur) - 1) * DAY];
  const center = start + ((dur - 1) / 2) * DAY;
  const half = 0.911 * dur * DAY;
  return [center - half, center + half];
}

export function matchEvent(ep: Pick<Episode, "series" | "dir" | "start" | "end">, dates: readonly string[], events: readonly GeneratorEvent[], isTotal: boolean): GeneratorEvent | null {
  const a = toTime(dates[ep.start]) - DAY;
  const b = toTime(dates[ep.end]) + DAY;
  let best: GeneratorEvent | null = null;
  let bestGap = Infinity;
  for (const ev of events) {
    if ((ev.factor < 1 ? -1 : 1) !== ep.dir || ev.factor === 1) continue;
    if (!isTotal && !ev.affected.includes(ep.series)) continue;
    if (isTotal && ev.affected.length === 0) continue;
    const [lo, hi] = eventWindow(ev);
    if (hi < a || lo > b) continue;
    const gap = Math.abs((lo + hi) / 2 - (a + b) / 2);
    if (gap < bestGap) {
      best = ev;
      bestGap = gap;
    }
  }
  return best;
}

/** Groups consecutive anomalous days of one series with the same direction into episodes. */
export function episodesOf(a: SeriesAnalysis, dates: readonly string[], events: readonly GeneratorEvent[], isTotal: boolean): Omit<Episode, "id">[] {
  const out: Omit<Episode, "id">[] = [];
  let cur: number[] = [];
  let curDir: 1 | -1 = 1;
  const flush = () => {
    if (!cur.length) return;
    let peak = cur[0];
    const dev = (i: number) => (a.expected[i] ? (a.values[i] - a.expected[i]) / a.expected[i] : 0);
    for (const i of cur) if (Math.abs(dev(i)) > Math.abs(dev(peak))) peak = i;
    const tests = TESTS.map((t) => t.id).filter((t) => cur.some((i) => a.flags[i].some((f) => f.test === t)));
    const ep = { series: a.name, dir: curDir, start: cur[0], end: cur[cur.length - 1], peak, points: cur, tests,
      peakValue: a.values[peak], peakExpected: a.expected[peak], peakDevPct: dev(peak) * 100, match: null as GeneratorEvent | null };
    ep.match = matchEvent(ep, dates, events, isTotal);
    out.push(ep);
    cur = [];
  };
  for (const i of a.anomalies) {
    const dir = directionOf(a, i);
    if (cur.length && (i !== cur[cur.length - 1] + 1 || dir !== curDir)) flush();
    curDir = dir;
    cur.push(i);
  }
  flush();
  return out;
}
