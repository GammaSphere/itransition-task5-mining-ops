import type { Dataset } from "../data/sheets";
import { analyzeSeries, episodesOf, estimateBaseline, eventWindow, growthRate, type DetectionSettings, type Episode, type SeriesAnalysis } from "./detect";

export interface Analysis {
  dates: string[];
  mines: SeriesAnalysis[];
  total: SeriesAnalysis;
  /** All anomaly episodes (mines and total), in date order. */
  episodes: Episode[];
  /** Day-of-week profile per series, always estimated (independent of the detection basis). */
  profiles: Map<string, number[]>;
  growth: number;
  /** How many (event, affected mine) pairs configured in the generator were detected. */
  coverage: { pairs: number; detected: number; matchedEpisodes: number; mineEpisodes: number } | null;
}

export const TOTAL = "Total";

export function runAnalysis(ds: Dataset, s: DetectionSettings): Analysis {
  const { dates } = ds;
  const mines = ds.mines.map((m) => analyzeSeries(m.name, dates, m.values, s));
  const totalValues = dates.map((_, i) => Math.round(ds.mines.reduce((acc, m) => acc + m.values[i], 0) * 100) / 100);
  const total = analyzeSeries(TOTAL, dates, totalValues, s);

  const raw = [...mines.flatMap((a) => episodesOf(a, dates, ds.events, false)), ...episodesOf(total, dates, ds.events, true)];
  const order = new Map([...mines.map((m, k) => [m.name, k] as const), [TOTAL, mines.length] as const]);
  raw.sort((a, b) => a.start - b.start || order.get(a.series)! - order.get(b.series)!);
  const episodes = raw.map((e, k) => ({ ...e, id: k + 1 }));

  const profiles = new Map<string, number[]>();
  for (const a of [...mines, total]) {
    profiles.set(a.name, dates.length >= 14 ? estimateBaseline(dates, a.values, { seasonal: true, detrend: true, degree: s.degree }).weekday : new Array(7).fill(1));
  }

  let coverage: Analysis["coverage"] = null;
  const first = Date.parse(dates[0] + "T00:00:00Z");
  const last = Date.parse(dates[dates.length - 1] + "T00:00:00Z");
  const inRange = ds.events.filter((ev) => {
    const [lo, hi] = eventWindow(ev);
    return ev.factor !== 1 && hi >= first && lo <= last;
  });
  if (inRange.length) {
    let pairs = 0;
    let detected = 0;
    for (const ev of inRange) {
      for (const m of ev.affected) {
        if (!mines.some((a) => a.name === m)) continue;
        pairs++;
        if (episodes.some((e) => e.series === m && e.match?.id === ev.id)) detected++;
      }
    }
    const mineEps = episodes.filter((e) => e.series !== TOTAL);
    coverage = { pairs, detected, matchedEpisodes: mineEps.filter((e) => e.match).length, mineEpisodes: mineEps.length };
  }

  return { dates, mines, total, episodes, profiles, growth: growthRate(dates, totalValues), coverage };
}
