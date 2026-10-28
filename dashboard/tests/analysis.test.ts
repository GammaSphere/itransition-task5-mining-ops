import { describe, expect, it } from "vitest";
import { analyzeSeries, DEFAULT_DETECTION, episodesOf, grubbs, movingAverage } from "../src/analysis/detect";
import { polyfit } from "../src/analysis/regression";
import { quantile, sd, summarize } from "../src/analysis/stats";
import { grubbsCritical, tCdf, tInv } from "../src/analysis/tdist";
import sample from "../public/sample-data.json";

// Reference values computed with SciPy / NumPy.
describe("Student t", () => {
  it("matches scipy", () => {
    expect(tInv(0.975, 10)).toBeCloseTo(2.2281388519862744, 8);
    expect(tInv(1 - 0.05 / 80, 38)).toBeCloseTo(3.487045629657974, 8);
    expect(tCdf(1.5, 7)).toBeCloseTo(0.911350756505015, 10);
    expect(tCdf(-2.1, 3)).toBeCloseTo(0.0632826012748423, 10);
  });
  it("gives Grubbs critical values", () => {
    expect(grubbsCritical(10, 0.05)).toBeCloseTo(2.2899540844796036, 8);
    expect(grubbsCritical(40, 0.05)).toBeCloseTo(3.0360973845112187, 8);
    expect(grubbsCritical(100, 0.05)).toBeCloseTo(3.384082901154918, 8);
  });
});

describe("descriptive statistics", () => {
  const x = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
  it("uses type-7 quantiles and the sample deviation", () => {
    expect(quantile(x, 0.25)).toBe(2.5);
    expect(quantile(x, 0.5)).toBe(4);
    expect(quantile(x, 0.75)).toBe(5);
    expect(sd(x)).toBeCloseTo(2.3664319132398464, 12);
    expect(summarize(x).iqr).toBe(2.5);
  });
});

describe("polynomial trend", () => {
  it("matches numpy.polyfit", () => {
    const y = [2.0, 3.1, 5.2, 8.9, 13.8, 20.1, 27.9, 37.2, 48.1, 60.0];
    const f = polyfit(y, 2);
    expect(f.at(0)).toBeCloseTo(2.16727273, 6);
    expect(f.at(4.5)).toBeCloseTo(16.8175, 6);
    expect(f.at(9)).toBeCloseTo(60.00181818, 6);
  });
  it("caps the degree for short series", () => {
    expect(polyfit([1, 2], 4).degree).toBe(1);
  });
});

describe("tests", () => {
  it("moving average never includes the tested day", () => {
    expect(movingAverage([1, 1, 1, 10], 3, "trailing")[3]).toBe(1);
    expect(movingAverage([1, 10, 1], 2, "centered")[1]).toBe(1);
  });
  it("Grubbs finds a planted outlier and nothing in clean data", () => {
    const clean = Array.from({ length: 30 }, (_, i) => 50 + Math.sin(i * 1.7) * 3);
    expect(grubbs(clean, 0.05, 5).outliers).toHaveLength(0);
    const dirty = [...clean];
    dirty[12] = 90;
    expect(grubbs(dirty, 0.05, 1).outliers.map((o) => o.i)).toEqual([12]);
  });
  it("generalized Grubbs is not masked by a cluster", () => {
    const base = Array.from({ length: 40 }, (_, i) => 50 + Math.sin(i * 1.7) * 3);
    const two = [...base];
    two[5] = 58;
    two[6] = 58.5;
    expect(grubbs(two, 0.05, 1).outliers).toHaveLength(0); // the classic test is masked
    expect(grubbs(two, 0.05, 5).outliers.map((o) => o.i).sort()).toEqual([5, 6]);
  });
});

describe("pipeline on the generator's default data", () => {
  const dates = sample.dates as string[];
  const mines = sample.mines as Record<string, number[]>;
  it("detects the configured drop in every mine and labels it", () => {
    for (const [name, values] of Object.entries(mines)) {
      const a = analyzeSeries(name, dates, values, DEFAULT_DETECTION);
      const eps = episodesOf(a, dates, sample.events, false);
      const rows = eps.map((e) => `${dates[e.start]}..${dates[e.end]} ${e.dir > 0 ? "spike" : "drop"} ${e.peakDevPct.toFixed(0)}% [${e.tests}] ${e.match ? "event " + e.match.id : "-"}`);
      console.log(name, a.counts, "\n  " + rows.join("\n  "));
      expect(eps.some((e) => e.dir === -1 && e.match?.id === 1)).toBe(true);
    }
  });
});
