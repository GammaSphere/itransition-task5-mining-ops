import { BarChart, BoxplotChart, HeatmapChart, LineChart, ScatterChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { directionOf, TESTS, type SeriesAnalysis } from "../analysis/detect";
import { quantile } from "../analysis/stats";
import { esc, longDate, num1, pct, shortDate, WEEKDAYS } from "./format";

echarts.use([LineChart, BarChart, ScatterChart, HeatmapChart, BoxplotChart, GridComponent, TooltipComponent,
  LegendComponent, DataZoomComponent, MarkLineComponent, VisualMapComponent, CanvasRenderer]);

export { echarts };
export type Option = echarts.EChartsCoreOption;
export type ChartType = "line" | "bar" | "stacked-bar" | "stacked-area";

// Reference categorical palette, fixed order; a mine keeps its slot (see colorFor in main.ts).
export const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const T = {
  ink: "#15232b",
  ink2: "#4a5a63",
  muted: "#7d8a91",
  grid: "#e6ebee",
  axis: "#b9c3c9",
  critical: "#d03b3b",
  band: "rgba(74, 90, 99, 0.13)",
  font: '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif',
};

export interface MainContext {
  dates: string[];
  mines: SeriesAnalysis[];
  total: SeriesAnalysis;
  colors: Map<string, string>;
  chartType: ChartType;
  showTrend: boolean;
  showTotal: boolean;
  print?: boolean;
}

const fs = (print?: boolean) => (print ? 17 : 12);

function axisBase(print?: boolean) {
  return {
    axisLine: { lineStyle: { color: T.axis } },
    axisTick: { show: false },
    axisLabel: { color: T.muted, fontSize: fs(print), fontFamily: T.font },
    splitLine: { lineStyle: { color: T.grid } },
  };
}

function dateAxis(dates: string[], print: boolean | undefined, boundaryGap: boolean) {
  return {
    type: "category",
    data: dates,
    boundaryGap,
    ...axisBase(print),
    splitLine: { show: false },
    axisLabel: { ...axisBase(print).axisLabel, formatter: (v: string) => shortDate(v), hideOverlap: true },
  };
}

const valueAxis = (print?: boolean, name = "t") => ({
  type: "value",
  name,
  nameTextStyle: { color: T.muted, fontSize: fs(print), align: "right" },
  ...axisBase(print),
  axisLine: { show: false },
});

const tooltipBase = {
  backgroundColor: "#fff",
  borderColor: "#d5dce0",
  textStyle: { color: T.ink, fontFamily: T.font, fontSize: 12.5 },
  extraCssText: "box-shadow: 0 4px 18px rgba(21,35,43,.12); border-radius: 6px;",
};

const glyph = (dir: number) => (dir > 0 ? "▲" : "▼");

function flagText(a: SeriesAnalysis, i: number): string {
  const f = a.flags[i];
  if (!f.length) return "";
  const names = f.map((x) => TESTS.find((t) => t.id === x.test)!.short).join(", ");
  const isAnom = a.anomalies.includes(i);
  return `<span style="color:${T.critical}">${isAnom ? glyph(directionOf(a, i)) + " anomaly" : "flagged"}: ${names}</span>`;
}

/** Line data with an anomaly marker (triangle up / down) only where the series is anomalous. */
function markedLine(a: SeriesAnalysis, print?: boolean, values = a.values) {
  const set = new Set(a.anomalies);
  return values.map((v, i) =>
    set.has(i)
      ? { value: v, symbol: "triangle", symbolSize: print ? 16 : 13, symbolRotate: directionOf(a, i) < 0 ? 180 : 0,
          itemStyle: { color: T.critical, borderColor: "#fff", borderWidth: 2 } }
      : { value: v, symbol: "none" },
  );
}

function markedBars(a: SeriesAnalysis, stacked: boolean, print?: boolean) {
  const set = new Set(a.anomalies);
  return a.values.map((v, i) =>
    set.has(i)
      ? { value: v, itemStyle: { borderColor: T.critical, borderWidth: 2 },
          label: { show: true, position: stacked ? "inside" : "top", formatter: glyph(directionOf(a, i)),
            color: stacked ? "#fff" : T.critical, fontSize: print ? 13 : 11, fontWeight: 700 } }
      : v,
  );
}

const trendLine = (a: SeriesAnalysis, color: string, print?: boolean) => ({
  type: "line",
  name: `${a.name} trend`,
  data: a.trend.fitted.map((v) => Math.round(v * 100) / 100),
  symbol: "none",
  silent: true,
  z: 4,
  lineStyle: { type: [6, 4], width: print ? 2 : 1.6, color, opacity: 0.95 },
  itemStyle: { color },
});

export function mainOption(c: MainContext): Option {
  const stacked = c.chartType === "stacked-bar" || c.chartType === "stacked-area";
  const isBar = c.chartType === "bar" || c.chartType === "stacked-bar";
  const series: object[] = [];
  const byName = new Map<string, SeriesAnalysis>([...c.mines, c.total].map((a) => [a.name, a]));

  for (const a of c.mines) {
    const color = c.colors.get(a.name)!;
    const common = { name: a.name, color, emphasis: { focus: "series" }, z: 2 };
    if (isBar) {
      series.push({ ...common, type: "bar", stack: stacked ? "mines" : undefined, barMaxWidth: 26, barGap: "10%",
        itemStyle: { borderRadius: stacked ? 0 : [3, 3, 0, 0] }, data: markedBars(a, stacked, c.print) });
    } else {
      series.push({ ...common, type: "line", stack: stacked ? "mines" : undefined, showSymbol: true, showAllSymbol: true,
        lineStyle: { width: c.print ? 2.4 : 2 }, areaStyle: stacked ? { opacity: 0.82 } : undefined,
        data: markedLine(a, c.print) });
    }
  }
  // Total: its own series next to the mines, or the outline of the stack.
  if (c.showTotal) {
    if (isBar && !stacked) {
      series.push({ name: "Total", type: "bar", color: T.ink, barMaxWidth: 26, itemStyle: { borderRadius: [3, 3, 0, 0] },
        data: markedBars(c.total, false, c.print) });
    } else {
      series.push({ name: "Total", type: "line", color: T.ink, z: 5, showSymbol: true, showAllSymbol: true,
        lineStyle: { width: stacked ? 1.4 : 2 }, data: markedLine(c.total, c.print) });
    }
  }
  if (c.showTrend) {
    if (stacked) series.push(trendLine(c.total, T.ink, c.print));
    else {
      for (const a of c.mines) series.push(trendLine(a, c.colors.get(a.name)!, c.print));
      if (c.showTotal) series.push(trendLine(c.total, T.ink, c.print));
    }
  }

  const n = c.dates.length;
  return {
    animation: !c.print,
    textStyle: { fontFamily: T.font },
    grid: { left: 8, right: 16, top: c.print ? 52 : 28, bottom: !c.print && n > 62 ? 52 : 8, containLabel: true },
    legend: c.print
      ? { top: 0, left: 0, itemWidth: 18, itemHeight: 8, textStyle: { color: T.ink2, fontSize: 17 },
          data: [...c.mines.map((a) => a.name), ...(c.showTotal ? ["Total"] : [])] }
      : { show: false },
    tooltip: {
      ...tooltipBase,
      trigger: "axis",
      axisPointer: { type: isBar ? "shadow" : "line", lineStyle: { color: T.axis } },
      formatter: (ps: { seriesName: string; dataIndex: number; color: string; value: number | { value: number } }[]) => {
        if (!ps.length) return "";
        const i = ps[0].dataIndex;
        const rows = ps.filter((p) => !p.seriesName.endsWith(" trend")).map((p) => {
          const a = byName.get(p.seriesName);
          const v = a ? a.values[i] : NaN;
          const tr = a && c.showTrend ? ` <span style="color:${T.muted}">trend ${num1(a.trend.fitted[i])}</span>` : "";
          const fl = a ? flagText(a, i) : "";
          return `<div style="display:flex;gap:8px;align-items:baseline"><span style="width:9px;height:9px;border-radius:2px;background:${p.color};display:inline-block"></span>`
            + `<span style="min-width:90px">${esc(p.seriesName)}</span><b>${num1(v)}</b>${tr}</div>${fl ? `<div style="margin:0 0 3px 17px">${fl}</div>` : ""}`;
        });
        return `<div style="font-weight:600;margin-bottom:4px">${longDate(c.dates[i])}</div>${rows.join("")}`;
      },
    },
    dataZoom: !c.print && n > 62 ? [{ type: "inside" }, { type: "slider", height: 18, bottom: 10, borderColor: T.grid }] : [],
    xAxis: dateAxis(c.dates, c.print, isBar),
    yAxis: valueAxis(c.print, "t"),
    series,
  };
}

/** One series in detail: normal range, expected level, moving average, the values and their flags. */
export function focusOption(a: SeriesAnalysis, dates: string[], color: string, maWindow: number, print?: boolean, range?: [number, number]): Option {
  const [lo, hi] = range ?? [0, dates.length - 1];
  const sl = <X,>(xs: X[]) => xs.slice(lo, hi + 1);
  const anomalies = new Set(a.anomalies);
  const actual = a.values.map((v, i) => {
    if (anomalies.has(i)) {
      return { value: v, symbol: "triangle", symbolSize: print ? 16 : 13, symbolRotate: directionOf(a, i) < 0 ? 180 : 0,
        itemStyle: { color: T.critical, borderColor: "#fff", borderWidth: 2 } };
    }
    if (a.flags[i].length) {
      return { value: v, symbol: "circle", symbolSize: print ? 9 : 7, itemStyle: { color: "#fff", borderColor: T.critical, borderWidth: 1.6 } };
    }
    return { value: v, symbol: "none" };
  });
  const maUnits = a.ma.map((m, i) => (m === null ? null : Math.round(m * a.dayIndex[i] * 100) / 100));
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    animation: !print,
    textStyle: { fontFamily: T.font },
    grid: { left: 8, right: 16, top: print ? 52 : 36, bottom: 8, containLabel: true },
    legend: {
      top: 0, left: 0, itemWidth: 18, itemHeight: 8, icon: "roundRect",
      textStyle: { color: T.ink2, fontSize: print ? 17 : 12 },
      data: [a.name, "Expected level", `${maWindow}-day moving average`, "Normal range (IQR fences)"],
    },
    tooltip: {
      ...tooltipBase,
      trigger: "axis",
      formatter: (ps: { dataIndex: number }[]) => {
        const i = lo + (ps[0]?.dataIndex ?? 0);
        const dev = a.expected[i] ? (a.values[i] / a.expected[i] - 1) * 100 : NaN;
        const fl = flagText(a, i);
        return `<div style="font-weight:600;margin-bottom:4px">${longDate(dates[i])}</div>`
          + `<div>${esc(a.name)}: <b>${num1(a.values[i])}</b> t</div>`
          + `<div style="color:${T.ink2}">Expected ${num1(a.expected[i])} t (${pct(dev)})</div>`
          + (maUnits[i] !== null ? `<div style="color:${T.ink2}">Moving average ${num1(maUnits[i]!)} t</div>` : "")
          + `<div style="color:${T.ink2}">Normal range ${num1(a.bandLo[i])} to ${num1(a.bandHi[i])} t</div>`
          + (fl ? `<div style="margin-top:3px">${fl}</div>` : "");
      },
    },
    xAxis: dateAxis(sl(dates), print, false),
    yAxis: valueAxis(print, "t"),
    series: [
      { name: "band-base", type: "line", stack: "band", data: sl(a.bandLo).map(r2), symbol: "none", silent: true, lineStyle: { opacity: 0 }, tooltip: { show: false } },
      { name: "Normal range (IQR fences)", type: "line", stack: "band", data: sl(a.bandHi.map((h, i) => h - a.bandLo[i])).map(r2), symbol: "none", silent: true,
        lineStyle: { opacity: 0 }, areaStyle: { color: T.band }, itemStyle: { color: "#c9d3d8" } },
      { name: "Expected level", type: "line", data: sl(a.expected).map(r2), symbol: "none", lineStyle: { type: [6, 4], width: 1.6, color: T.ink2 }, itemStyle: { color: T.ink2 } },
      { name: `${maWindow}-day moving average`, type: "line", data: sl(maUnits), symbol: "none", connectNulls: false, lineStyle: { width: 1.2, color: "#9aa8af" }, itemStyle: { color: "#9aa8af" } },
      { name: a.name, type: "line", data: sl(actual), showSymbol: true, showAllSymbol: true, z: 5, lineStyle: { width: print ? 2.6 : 2.2, color }, itemStyle: { color } },
    ],
  };
}

/** Days x tests grid: which test flagged which day, plus the consensus row. */
export function matrixOption(a: SeriesAnalysis, dates: string[], minTests: number, print?: boolean): Option {
  const rows = [...TESTS.map((t) => t.short === "G" ? "Grubbs" : t.short), `Anomaly (≥${minTests})`].reverse();
  const data: [number, number, number][] = [];
  const anomalies = new Set(a.anomalies);
  dates.forEach((_, i) => {
    TESTS.forEach((t, k) => {
      const f = a.flags[i].find((x) => x.test === t.id);
      data.push([i, rows.length - 1 - k, f ? f.dir : 0]);
    });
    data.push([i, 0, anomalies.has(i) ? 2 * directionOf(a, i) : 0]);
  });
  const wide = dates.length <= 70;
  return {
    animation: false,
    textStyle: { fontFamily: T.font },
    grid: { left: 8, right: 16, top: 4, bottom: 4, containLabel: true },
    tooltip: {
      ...tooltipBase,
      formatter: (p: { value: [number, number, number] }) => {
        const [i, r, v] = p.value;
        const what = v === 0 ? "not flagged" : `${glyph(v)} ${v > 0 ? "spike" : "drop"}`;
        return `<b>${longDate(dates[i])}</b><br>${rows[r]}: ${what}`;
      },
    },
    xAxis: { ...dateAxis(dates, print, true), axisLine: { show: false } },
    yAxis: { type: "category", data: rows, ...axisBase(print), axisLine: { show: false }, splitLine: { show: false } },
    visualMap: {
      type: "piecewise", show: false, dimension: 2,
      pieces: [{ value: 0, color: "#eef2f4" }, { value: 1, color: "#e07a7a" }, { value: -1, color: "#e07a7a" }, { value: 2, color: T.critical }, { value: -2, color: T.critical }],
    },
    series: [{
      type: "heatmap", data,
      itemStyle: { borderColor: "#fff", borderWidth: 2 },
      label: { show: wide, color: "#fff", fontSize: print ? 11 : 9, formatter: (p: { value: [number, number, number] }) => (p.value[2] ? glyph(p.value[2]) : "") },
      emphasis: { itemStyle: { borderColor: T.ink, borderWidth: 1 } },
    }],
  };
}

export function boxOption(mines: SeriesAnalysis[], colors: Map<string, string>, k: number, print?: boolean): Option {
  const boxes = mines.map((a) => {
    const v = [...a.values].sort((x, y) => x - y);
    const q1 = quantile(v, 0.25);
    const q3 = quantile(v, 0.75);
    const iqr = q3 - q1;
    const inside = v.filter((x) => x >= q1 - k * iqr && x <= q3 + k * iqr);
    return { box: [inside[0], q1, quantile(v, 0.5), q3, inside[inside.length - 1]], out: v.filter((x) => x < q1 - k * iqr || x > q3 + k * iqr) };
  });
  return {
    animation: !print,
    textStyle: { fontFamily: T.font },
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    tooltip: { ...tooltipBase, trigger: "item" },
    xAxis: { type: "category", data: mines.map((a) => a.name), ...axisBase(print), splitLine: { show: false } },
    yAxis: valueAxis(print, "t"),
    series: [
      {
        type: "boxplot", name: "Daily output", boxWidth: [18, 46],
        data: boxes.map((b, i) => ({ value: b.box, itemStyle: { color: colors.get(mines[i].name) + "33", borderColor: colors.get(mines[i].name), borderWidth: 1.6 } })),
        tooltip: { formatter: (p: { name: string; value: number[] }) =>
          `<b>${esc(p.name)}</b><br>Max (in fence) ${num1(p.value[5])}<br>Q3 ${num1(p.value[4])}<br>Median ${num1(p.value[3])}<br>Q1 ${num1(p.value[2])}<br>Min (in fence) ${num1(p.value[1])}` },
      },
      {
        type: "scatter", name: `Outside ${k} x IQR`, symbolSize: print ? 9 : 7, itemStyle: { color: T.critical, borderColor: "#fff", borderWidth: 1 },
        data: boxes.flatMap((b, i) => b.out.map((x) => [i, x])),
        tooltip: { formatter: (p: { value: [number, number] }) => `${esc(mines[p.value[0]].name)}: ${num1(p.value[1])} t, outside the whiskers` },
      },
    ],
  };
}

export function weekOption(mines: SeriesAnalysis[], profiles: Map<string, number[]>, colors: Map<string, string>, print?: boolean): Option {
  return {
    animation: !print,
    textStyle: { fontFamily: T.font },
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    tooltip: { ...tooltipBase, trigger: "axis", axisPointer: { type: "shadow" },
      valueFormatter: (v: number) => `${(v * 100).toFixed(0)}% of an average day` },
    xAxis: { type: "category", data: WEEKDAYS, ...axisBase(print), splitLine: { show: false } },
    yAxis: { ...valueAxis(print, "index"), min: 0 },
    series: mines.map((a, k) => ({
      type: "bar", name: a.name, color: colors.get(a.name), barMaxWidth: 18, barGap: "12%",
      itemStyle: { borderRadius: [3, 3, 0, 0] },
      data: (profiles.get(a.name) ?? []).map((x) => Math.round(x * 1000) / 1000),
      markLine: k === 0 ? { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: T.ink2, type: [4, 4], width: 1 }, data: [{ yAxis: 1 }] } : undefined,
    })),
  };
}
