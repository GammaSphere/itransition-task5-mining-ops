import { jsPDF } from "jspdf";
import autoTable, { type CellHookData, type RowInput } from "jspdf-autotable";
import { directionOf, TESTS, type DetectionSettings, type Episode } from "../analysis/detect";
import { TOTAL, type Analysis } from "../analysis/run";
import type { Dataset } from "../data/sheets";
import type { ViewSettings } from "../main";
import { echarts, focusOption, mainOption, matrixOption, boxOption, weekOption, type Option } from "../ui/charts";
import { WEEKDAYS } from "../ui/format";

export interface ReportInput {
  dataset: Dataset;
  analysis: Analysis;
  detect: DetectionSettings;
  view: ViewSettings;
  colors: Map<string, string>;
  sheetId: string | null;
}

// Page geometry (mm) and palette ---------------------------------------------------------------
const PW = 210;
const PH = 297;
const M = 16;
const CW = PW - 2 * M;
const TOP = 26;
const BOTTOM = PH - 18;
type RGB = [number, number, number];
const INK: RGB = [21, 35, 43];
const INK2: RGB = [74, 90, 99];
const MUTED: RGB = [125, 138, 145];
const RULE: RGB = [213, 220, 224];
const WASH: RGB = [242, 244, 245];
const AMBER: RGB = [242, 169, 0];
const CRIT: RGB = [208, 59, 59];

// PDF standard fonts only cover WinAnsi: keep text to that range.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dmy = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const dm = (iso: string) => dmy(iso).replace(/ \d{4}$/, "");
const span = (a: string, b: string) => (a === b ? dmy(a) : a.slice(0, 4) === b.slice(0, 4) ? `${dm(a)} to ${dmy(b)}` : `${dmy(a)} to ${dmy(b)}`);
const n0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "n/a");
const n1 = (x: number) => (Number.isFinite(x) ? x.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "n/a");
const n2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
const pc = (x: number, d = 0) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "-"}${Math.abs(x).toFixed(d)}%` : "n/a");
const testShort = (id: string) => (id === "grubbs" ? "Grubbs" : TESTS.find((t) => t.id === id)!.short);

const ASCII: Record<string, string> = { "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u2022": "*", "\u2026": "...", "\u2018": "'", "\u2019": "'", "\u201C": '"', "\u201D": '"', "\u00D7": "x" };

/** Helvetica in jsPDF only covers WinAnsi: strip accents and replace anything else. */
export function pdfSafe(s: string): string {
  return s
    .replace(/[\u2013\u2014\u2212\u2022\u2026\u2018\u2019\u201C\u201D\u00D7]/g, (c) => ASCII[c])
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "?");
}

/** Renders an ECharts option offscreen and returns a PNG data URL. */
async function snapshot(option: Option, width: number, height: number): Promise<string> {
  const el = document.createElement("div");
  el.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px`;
  document.body.appendChild(el);
  const c = echarts.init(el, undefined, { renderer: "canvas", width, height });
  try {
    c.setOption({ ...option, animation: false });
    await new Promise((r) => setTimeout(r, 30));
    return c.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#ffffff" });
  } finally {
    c.dispose();
    el.remove();
  }
}

class Report {
  doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  y = TOP;

  constructor(readonly title: string, readonly subtitle: string) {
    // Every string reaches the page through doc.text (autoTable included), so sanitize there once.
    const text = this.doc.text.bind(this.doc) as (...args: unknown[]) => jsPDF;
    (this.doc as unknown as { text: (...args: unknown[]) => jsPDF }).text = (t: unknown, ...rest: unknown[]) =>
      text(typeof t === "string" ? pdfSafe(t) : Array.isArray(t) ? t.map((x) => (typeof x === "string" ? pdfSafe(x) : x)) : t, ...rest);
    this.doc.setFont("helvetica", "normal");
    this.doc.setLineHeightFactor(1.35);
  }

  color(c: RGB, what: "text" | "fill" | "draw" = "text") {
    if (what === "text") this.doc.setTextColor(...c);
    else if (what === "fill") this.doc.setFillColor(...c);
    else this.doc.setDrawColor(...c);
  }

  ensure(h: number) {
    if (this.y + h > BOTTOM) this.newPage();
  }

  newPage() {
    this.doc.addPage();
    this.y = TOP;
  }

  h1(text: string) {
    this.ensure(22);
    this.y += 2;
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(15);
    this.color(INK);
    this.doc.text(text, M, this.y);
    this.y += 2.5;
    this.color(AMBER, "draw");
    this.doc.setLineWidth(0.8);
    this.doc.line(M, this.y, M + 14, this.y);
    this.y += 6;
  }

  h2(text: string, need = 16) {
    this.ensure(need);
    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(11.5);
    this.color(INK);
    this.doc.text(text, M, this.y);
    this.y += 5.5;
  }

  para(text: string, opts: { size?: number; color?: RGB; indent?: number; gap?: number } = {}) {
    const size = opts.size ?? 9.5;
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(size);
    this.color(opts.color ?? INK2);
    const lines = this.doc.splitTextToSize(text, CW - (opts.indent ?? 0)) as string[];
    const lh = size * 0.3528 * 1.4;
    this.ensure(lines.length * lh + 1);
    this.doc.text(lines, M + (opts.indent ?? 0), this.y);
    this.y += lines.length * lh + (opts.gap ?? 2.5);
  }

  bullets(items: string[]) {
    for (const it of items) {
      this.doc.setFontSize(9.5);
      const lines = this.doc.splitTextToSize(it, CW - 5) as string[];
      this.ensure(lines.length * 4.7 + 1);
      this.color(AMBER, "fill");
      this.doc.rect(M + 0.4, this.y - 2.4, 1.6, 1.6, "F");
      this.para(it, { indent: 5, gap: 1.6 });
    }
    this.y += 1.5;
  }

  image(data: string, h: number, caption?: string) {
    this.ensure(h + (caption ? 8 : 3));
    this.doc.addImage(data, "PNG", M, this.y, CW, h, undefined, "FAST");
    this.y += h + 2;
    if (caption) this.para(caption, { size: 8, color: MUTED, gap: 4 });
    else this.y += 2;
  }

  table(head: RowInput[], body: RowInput[], opts: Partial<Parameters<typeof autoTable>[1]> = {}) {
    autoTable(this.doc, {
      head,
      body,
      startY: this.y,
      margin: { left: M, right: M, top: TOP, bottom: PH - BOTTOM },
      theme: "plain",
      styles: { font: "helvetica", fontSize: 8, textColor: INK, cellPadding: { top: 1.5, bottom: 1.5, left: 1.8, right: 1.8 }, lineColor: RULE, lineWidth: { bottom: 0.15 } },
      headStyles: { fontStyle: "bold", textColor: INK2, fillColor: WASH, lineWidth: { bottom: 0.3 }, lineColor: [185, 195, 201] },
      ...opts,
    });
    this.y = (this.doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  }

  /** Header band, hazard stripe and footer on every page. */
  frame(footerLeft: string) {
    const total = this.doc.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      this.doc.setPage(p);
      this.color(INK, "fill");
      this.doc.rect(0, 0, PW, 13, "F");
      // amber / ink hazard stripe
      this.color(AMBER, "fill");
      this.doc.rect(0, 13, PW, 1.6, "F");
      this.color(INK, "fill");
      for (let x = -2; x < PW + 2; x += 3.2) this.doc.triangle(x, 14.6, x + 1.6, 13, x + 1.6 + 1.6, 13, "F"), this.doc.triangle(x, 14.6, x + 1.6, 14.6, x + 3.2, 13, "F");
      this.doc.setFont("helvetica", "bold");
      this.doc.setFontSize(9.5);
      this.doc.setTextColor(255, 255, 255);
      this.doc.text("WEYLAND-YUTANI", M, 8.4);
      this.doc.setFont("helvetica", "normal");
      this.doc.setTextColor(185, 198, 205);
      this.doc.text(this.title, M + 33, 8.4);
      this.doc.text(this.subtitle, PW - M, 8.4, { align: "right" });
      this.doc.setFontSize(7.5);
      this.color(MUTED);
      this.color(RULE, "draw");
      this.doc.setLineWidth(0.2);
      this.doc.line(M, PH - 12.5, PW - M, PH - 12.5);
      this.doc.text(footerLeft, M, PH - 8.5);
      this.doc.text(`Page ${p} of ${total}`, PW - M, PH - 8.5, { align: "right" });
    }
  }
}

/** Draws a small up / down triangle in the first column of anomaly tables. */
function triangleHook(dirs: Map<number, number>, col: number) {
  return (d: CellHookData) => {
    if (d.section !== "body" || d.column.index !== col) return;
    const dir = dirs.get(d.row.index);
    if (!dir) return;
    const x = d.cell.x + 1.6;
    const cy = d.cell.y + d.cell.height / 2;
    d.doc.setFillColor(...CRIT);
    if (dir > 0) d.doc.triangle(x, cy + 1.1, x + 2.4, cy + 1.1, x + 1.2, cy - 1.1, "F");
    else d.doc.triangle(x, cy - 1.1, x + 2.4, cy - 1.1, x + 1.2, cy + 1.1, "F");
  };
}

function findings(inp: ReportInput): string[] {
  const { analysis: a } = inp;
  const out: string[] = [];
  const t = a.total.summary;
  out.push(`Total output over ${a.dates.length} days was ${n0(t.sum)} t, ${n1(t.mean)} t per day on average. The underlying level of total output changed by ${pc(a.growth * 100, 1)} per day.`);
  if (a.mines.length > 1) {
    const top = [...a.mines].sort((x, y) => y.summary.mean - x.summary.mean)[0];
    const vol = a.mines.filter((m) => Number.isFinite(m.summary.cv)).sort((x, y) => y.summary.cv - x.summary.cv)[0];
    out.push(`${top.name} produced the most (mean ${n1(top.summary.mean)} t per day).` +
      (vol ? ` ${vol.name} was the most variable (coefficient of variation ${(vol.summary.cv * 100).toFixed(0)}%).` : ""));
  }
  const prof = a.profiles.get(TOTAL);
  if (prof) {
    const lo = prof.indexOf(Math.min(...prof));
    const hi = prof.indexOf(Math.max(...prof));
    out.push(`Weekly pattern: ${WEEKDAYS[lo]} output is ${(prof[lo] * 100).toFixed(0)}% of an average day, ${WEEKDAYS[hi]} ${(prof[hi] * 100).toFixed(0)}%.`);
  }
  const eps = a.episodes;
  if (eps.length) {
    const drops = eps.filter((e) => e.dir < 0);
    const spikes = eps.filter((e) => e.dir > 0);
    out.push(`${eps.length} anomaly episode${eps.length === 1 ? "" : "s"}: ${drops.length} drop${drops.length === 1 ? "" : "s"} and ${spikes.length} spike${spikes.length === 1 ? "" : "s"}.`);
    const worst = (xs: Episode[]) => xs.sort((x, y) => Math.abs(y.peakDevPct) - Math.abs(x.peakDevPct))[0];
    const wd = worst([...drops]);
    const ws = worst([...spikes]);
    if (wd) out.push(`Largest drop: A${wd.id}, ${wd.series} on ${dmy(a.dates[wd.peak])}, ${Math.abs(wd.peakDevPct).toFixed(0)}% below the expected level.`);
    if (ws) out.push(`Largest spike: A${ws.id}, ${ws.series} on ${dmy(a.dates[ws.peak])}, ${ws.peakDevPct.toFixed(0)}% above the expected level.`);
  } else {
    out.push(`No anomalies: no day was flagged by ${inp.detect.minTests} or more of the 4 tests.`);
  }
  if (a.coverage?.pairs) {
    const c = a.coverage;
    out.push(`Against the events configured in the generator, ${c.detected} of ${c.pairs} event hits on individual mines were detected, and ${c.matchedEpisodes} of ${c.mineEpisodes} mine episodes correspond to a configured event.`);
  }
  return out;
}

function eventText(e: Episode["match"]): string {
  if (!e) return "";
  return `#${e.id}: x${n2(e.factor)}, ${dm(e.day)}, ${e.duration} d ${e.shape === "Flat" ? "flat" : "bell"}`;
}

export async function buildReport(inp: ReportInput): Promise<void> {
  const { dataset: ds, analysis: a, detect: d, view: v, colors } = inp;
  const first = a.dates[0];
  const last = a.dates[a.dates.length - 1];
  const r = new Report("Mining operations report", span(first, last));
  const doc = r.doc;
  const generated = new Date();
  const seriesAll = [...a.mines, a.total];

  // Cover --------------------------------------------------------------------------------------
  r.y = 34;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(24);
  r.color(INK);
  doc.text("Mining operations report", M, r.y);
  r.y += 8;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  r.color(INK2);
  doc.text(`${a.mines.length} mine${a.mines.length === 1 ? "" : "s"}, ${span(first, last)} (${a.dates.length} days)`, M, r.y);
  r.y += 9;

  const kpis: [string, string, string][] = [
    ["Total output", `${n0(a.total.summary.sum)} t`, `${n1(a.total.summary.mean)} t per day`],
    ["Underlying growth", `${pc(a.growth * 100, 1)} per day`, "total output, weekly pattern removed"],
    ["Anomaly episodes", String(a.episodes.length), `${a.episodes.filter((e) => e.dir < 0).length} drops, ${a.episodes.filter((e) => e.dir > 0).length} spikes`],
    ["Mines", String(a.mines.length), a.mines.map((m) => m.name).join(", ")],
    ["Peak day", `${n0(Math.max(...a.total.values))} t`, dmy(a.dates[a.total.values.indexOf(Math.max(...a.total.values))])],
    ["Event hits found", a.coverage?.pairs ? `${a.coverage.detected} of ${a.coverage.pairs}` : "n/a", a.coverage?.pairs ? "configured in the generator" : "no generator events available"],
  ];
  const bw = (CW - 2 * 4) / 3;
  kpis.forEach(([k, val, sub], i) => {
    const x = M + (i % 3) * (bw + 4);
    const y = r.y + Math.floor(i / 3) * 24;
    r.color(WASH, "fill");
    doc.rect(x, y, bw, 20, "F");
    r.color(AMBER, "fill");
    doc.rect(x, y, 1.2, 20, "F");
    doc.setFontSize(8);
    r.color(MUTED);
    doc.text(k, x + 4.5, y + 5.5);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    r.color(INK);
    doc.text(val, x + 4.5, y + 12.5);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    r.color(INK2);
    doc.text((doc.splitTextToSize(sub, bw - 7) as string[])[0], x + 4.5, y + 17);
  });
  r.y += 52;

  r.h2("Key findings");
  r.bullets(findings(inp));

  r.h2("About this report", 30);
  const src = ds.source === "sheet" && inp.sheetId ? `https://docs.google.com/spreadsheets/d/${inp.sheetId}` : "offline sample dataset (the spreadsheet was not reachable)";
  r.table([], [
    ["Data source", src],
    ["Data read at", ds.fetchedAt.toLocaleString("en-GB")],
    ["Report generated", generated.toLocaleString("en-GB")],
    ["Anomaly rule", `a day is an anomaly when at least ${d.minTests} of the 4 tests flag it; consecutive anomalous days form an episode`],
    ["Test basis", !d.detrend && !d.seasonal ? "raw daily output" : `relative deviation from the expected level (robust log-linear fit: ${d.detrend ? `degree-${d.degree} trend` : "no trend"}${d.seasonal ? ", weekday profile" : ""})`],
  ], { columnStyles: { 0: { cellWidth: 36, textColor: INK2 } }, styles: { fontSize: 8.5, cellPadding: 1.6, lineColor: RULE, lineWidth: { bottom: 0.15 } } });

  // 1. Output -------------------------------------------------------------------------------
  r.newPage();
  r.h1("1. Daily output");
  const typeName = { line: "line chart", bar: "bar chart", "stacked-bar": "stacked bars", "stacked-area": "stacked area" }[v.chartType];
  const visible = a.mines.filter((m) => !v.hidden.includes(m.name));
  const mainImg = await snapshot(mainOption({ dates: a.dates, mines: visible, total: a.total, colors, chartType: v.chartType, showTrend: v.showTrend, showTotal: v.showTotal, print: true }), 1000, 470);
  r.image(mainImg, CW * 0.47,
    `Daily output by mine (${typeName}${v.showTrend ? `, dashed: polynomial trend of degree ${d.degree}` : ""}). Red triangles mark anomalies (up: spike, down: drop).`);
  const totalImg = await snapshot(mainOption({ dates: a.dates, mines: [], total: a.total, colors, chartType: "line", showTrend: true, showTotal: true, print: true }), 1000, 360);
  r.image(totalImg, CW * 0.36, `Total output of all mines with its degree-${d.degree} trend (R squared ${n2(a.total.trend.r2)}).`);

  // 2. Statistics ---------------------------------------------------------------------------
  r.h1("2. Descriptive statistics");
  r.para("Daily output in tonnes. Quartiles use linear interpolation (Excel QUARTILE.INC); the standard deviation is the sample deviation (n - 1).", { size: 8.5 });
  const statRows = seriesAll.map((s) => {
    const m = s.summary;
    return [s.name, n1(m.mean), n1(m.sd), n1(m.median), n1(m.q1), n1(m.q3), n1(m.iqr), n1(m.min), n1(m.max), Number.isFinite(m.cv) ? `${(m.cv * 100).toFixed(0)}%` : "n/a"];
  });
  r.table([["Series", "Mean", "Std dev", "Median", "Q1", "Q3", "IQR", "Min", "Max", "CV"]], statRows, {
    columnStyles: { 0: { halign: "left", fontStyle: "bold" } },
    didParseCell: (h) => {
      if (h.column.index > 0) h.cell.styles.halign = "right";
      if (h.section === "body" && h.row.index === statRows.length - 1) h.cell.styles.fillColor = WASH;
    },
  });
  const [boxImg, weekImg] = await Promise.all([
    snapshot(boxOption(a.mines, colors, d.iqrK, true), 640, 420),
    snapshot(weekOption(a.mines, a.profiles, colors, true), 640, 420),
  ]);
  r.ensure(66);
  const half = (CW - 6) / 2;
  doc.addImage(boxImg, "PNG", M, r.y, half, half * 0.656, undefined, "FAST");
  doc.addImage(weekImg, "PNG", M + half + 6, r.y, half, half * 0.656, undefined, "FAST");
  r.y += half * 0.656 + 2;
  r.para(`Left: distribution of daily output (whiskers at ${d.iqrK} x IQR, red dots outside). Right: output on each weekday relative to an average day, estimated from the data.`, { size: 8, color: MUTED, gap: 4 });

  // 3. Detection ---------------------------------------------------------------------------
  r.h1("3. Anomaly detection");
  r.para(!d.detrend && !d.seasonal
    ? "All tests run on the raw daily output of each series."
    : "Output grows and follows a weekly cycle, so a raw value says little on its own. Each series is first fitted with a robust regression of log(output) on a polynomial trend and day-of-week effects (Tukey bisquare weights, so anomalous days barely influence the fit). The IQR rule, the z-score and Grubbs' test then run on each day's relative deviation from that expected level; the moving-average test runs on the output with the weekly pattern divided out.");
  r.table([["Test", "Rule", "Parameters"]], [
    ["IQR rule", "below Q1 - k x IQR or above Q3 + k x IQR", `k = ${d.iqrK}`],
    ["Z-score", `|x - ${d.zRobust ? "median" : "mean"}| / ${d.zRobust ? "(1.4826 x MAD)" : "sd"} above the threshold`, `threshold ${d.zThreshold}${d.zRobust ? ", robust" : ""}`],
    ["Distance from moving average", "relative distance from the average of the surrounding days", `${d.maWindow} days ${d.maMode}, ${d.maPct}%`],
    ["Grubbs' test", "generalized ESD: up to r outliers, two-sided", `alpha = ${d.grubbsAlpha}, r = ${d.grubbsMax}`],
    ["Anomaly", "days flagged by enough tests", `at least ${d.minTests} of 4`],
  ], { columnStyles: { 0: { fontStyle: "bold", cellWidth: 46 }, 2: { cellWidth: 46 } } });

  r.h2("Days flagged per test");
  r.table([["Series", ...TESTS.map((t) => testShort(t.id)), "Anomalous days", "Episodes"]],
    seriesAll.map((s) => [s.name, ...TESTS.map((t) => String(s.counts[t.id])), String(s.anomalies.length), String(a.episodes.filter((e) => e.series === s.name).length)]),
    { columnStyles: { 0: { fontStyle: "bold" } }, didParseCell: (h) => { if (h.column.index > 0) h.cell.styles.halign = "right"; } });

  r.h2("Anomaly episodes");
  if (a.episodes.length) {
    const dirs = new Map(a.episodes.map((e, k) => [k, e.dir]));
    r.table([["", "ID", "Series", "Dates", "Days", "Peak, t", "Expected, t", "Deviation", "Tests", "Generator event"]],
      a.episodes.map((e) => ["", `A${e.id}`, e.series, span(a.dates[e.start], a.dates[e.end]), String(e.end - e.start + 1), n1(e.peakValue), n1(e.peakExpected), pc(e.peakDevPct),
        e.tests.map(testShort).join(", "), e.match ? eventText(e.match) : "-"]),
      { columnStyles: { 0: { cellWidth: 5 }, 1: { fontStyle: "bold" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" }, 7: { halign: "right" } },
        styles: { fontSize: 7.5, cellPadding: 1.4, lineColor: RULE, lineWidth: { bottom: 0.15 } }, didDrawCell: triangleHook(dirs, 0) });
  } else {
    r.para(`No day was flagged by ${d.minTests} or more tests.`);
  }

  // 4. Series detail ------------------------------------------------------------------------
  r.newPage();
  r.h1("4. Series detail");
  r.para("Each chart shows the series, its expected level (dashed), the moving average and the normal range between the IQR fences. Filled triangles are anomalies; hollow circles are days flagged by fewer tests than required. The matrix below shows which test flagged which day.", { size: 8.5 });
  for (const s of seriesAll) {
    const color = colors.get(s.name) ?? "#15232b";
    const [img, mat] = await Promise.all([
      snapshot(focusOption(s, a.dates, color, d.maWindow, true), 1000, 360),
      snapshot(matrixOption(s, a.dates, d.minTests, true), 1000, 165),
    ]);
    r.ensure(CW * 0.36 + CW * 0.165 + 24);
    r.h2(s.name === TOTAL ? "Total (all mines)" : s.name);
    const m = s.summary;
    r.para(`Mean ${n1(m.mean)} t, sd ${n1(m.sd)} t, median ${n1(m.median)} t, IQR ${n1(m.iqr)} t, range ${n1(m.min)} to ${n1(m.max)} t. ` +
      `Flags: ${TESTS.map((t) => `${testShort(t.id)} ${s.counts[t.id]}`).join(", ")}; ${s.anomalies.length} anomalous day${s.anomalies.length === 1 ? "" : "s"}. ` +
      `Weekly pattern: ${WEEKDAYS.map((w, k) => `${w} ${((a.profiles.get(s.name)?.[k] ?? 1) * 100).toFixed(0)}%`).join(", ")}.`, { size: 8.5 });
    doc.addImage(img, "PNG", M, r.y, CW, CW * 0.36, undefined, "FAST");
    r.y += CW * 0.36 + 1;
    doc.addImage(mat, "PNG", M, r.y, CW, CW * 0.165, undefined, "FAST");
    r.y += CW * 0.165 + 6;
  }

  // 5. Anomaly sections -----------------------------------------------------------------------
  if (a.episodes.length) {
    r.newPage();
    r.h1("5. Anomaly details");
    r.para("One section per episode. Each chart is zoomed to the episode with a week of context on either side.", { size: 8.5 });
    for (const e of a.episodes) {
      const s = seriesAll.find((x) => x.name === e.series)!;
      const lo = Math.max(0, e.start - 7);
      const hi = Math.min(a.dates.length - 1, e.end + 7);
      const img = await snapshot(focusOption(s, a.dates, colors.get(s.name) ?? "#15232b", d.maWindow, true, [lo, hi]), 1000, 330);
      const days = e.end - e.start + 1;
      r.ensure(30 + CW * 0.33 + days * 5.5 + 12);
      const kind = e.dir > 0 ? "Spike" : "Drop";
      r.color(CRIT, "fill");
      const ty = r.y - 3.3;
      if (e.dir > 0) doc.triangle(M, ty + 3.4, M + 3.4, ty + 3.4, M + 1.7, ty, "F");
      else doc.triangle(M, ty, M + 3.4, ty, M + 1.7, ty + 3.4, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11.5);
      r.color(INK);
      doc.text(`A${e.id}. ${kind} at ${e.series === TOTAL ? "total output" : e.series}, ${span(a.dates[e.start], a.dates[e.end])}`, M + 5.5, r.y);
      r.y += 5.5;
      const above = e.dir > 0 ? "above" : "below";
      r.para(`${days === 1 ? "On" : "Over"} ${days} day${days === 1 ? "" : "s"} output was ${above} its expected level, peaking on ${dmy(a.dates[e.peak])} at ${n1(e.peakValue)} t against ${n1(e.peakExpected)} t expected (${pc(e.peakDevPct)}). ` +
        `Flagged by ${e.tests.map((t) => TESTS.find((x) => x.id === t)!.name).join(", ")}. ` +
        (e.match ? `It corresponds to generator event #${e.match.id} (factor ${n2(e.match.factor)} from ${dmy(e.match.day)}, ${e.match.duration} day${e.match.duration === 1 ? "" : "s"}, ${e.match.shape.toLowerCase()} shape${e.match.affected.length ? `, hitting ${e.match.affected.join(", ")}` : ""}).`
          : ds.events.length ? "No event configured in the generator explains it." : ""), { size: 9 });
      r.image(img, CW * 0.33);
      const dirs = new Map(e.points.map((i, k) => [k, directionOf(s, i)]));
      r.table([["", "Date", "Output, t", "Expected, t", "Deviation", "z", "vs moving avg", "Flagged by"]],
        e.points.map((i) => {
          const z = s.zStats.sd > 0 ? (s.basis[i] - s.zStats.mean) / s.zStats.sd : 0;
          const ma = s.ma[i];
          return ["", dmy(a.dates[i]), n1(s.values[i]), n1(s.expected[i]), pc((s.values[i] / s.expected[i] - 1) * 100), n2(z),
            ma ? pc((s.adjusted[i] / ma - 1) * 100) : "-", s.flags[i].map((f) => testShort(f.test)).join(", ")];
        }),
        { columnStyles: { 0: { cellWidth: 5 } }, didParseCell: (h) => { if (h.column.index >= 2 && h.column.index <= 6) h.cell.styles.halign = "right"; },
          didDrawCell: triangleHook(dirs, 0) });
    }
  }

  // Appendix ------------------------------------------------------------------------------------
  r.newPage();
  r.h1("Appendix: generator settings");
  const p = ds.params;
  if (p) {
    r.table([["Setting", "Value"]], [
      ["Start date, days", `${p.start ? dmy(p.start) : "-"}, ${p.days}`],
      ["Mines", p.mines.join(", ")],
      ["Distribution", `${p.distribution}${p.params.length ? ": " + p.params.map((x) => `${x.label} ${x.value ?? "-"}`).join(", ") : ""}`],
      ["Smoothing (day-to-day correlation)", String(p.smoothing ?? "-")],
      ["Correlation between mines", String(p.correlation ?? "-")],
      ["Seed", String(p.seed ?? "-")],
      ["Day-of-week factors", WEEKDAYS.map((w, k) => `${w} ${p.weekday[k] ?? "-"}`).join(", ")],
      ["Daily growth", `${p.growth !== null ? (p.growth * 100).toFixed(2) + "%" : "-"} ${p.trend.toLowerCase()}`],
    ], { columnStyles: { 0: { cellWidth: 60, textColor: INK2 } } });
  } else {
    r.para("Generator settings were not available for this dataset.");
  }
  if (ds.events.length) {
    r.h2("Configured events");
    r.table([["#", "Day", "Duration", "Factor", "Probability", "Mines", "Shape", "Affected mines"]],
      ds.events.map((e) => [String(e.id), dmy(e.day), `${e.duration} d`, n2(e.factor), e.probability ?? "-", e.mines ?? "-", e.shape, e.affected.join(", ") || "none"].map(String)));
  }
  r.h2("Method notes");
  r.bullets([
    "IQR rule: Q1 and Q3 of the test basis; a day outside [Q1 - k IQR, Q3 + k IQR] is flagged.",
    "Z-score: z = (x - mean) / sd of the test basis (median and 1.4826 x MAD when robust).",
    "Moving average: the tested day is excluded from its own average, so one anomaly cannot hide itself.",
    "Grubbs' test: G = max |x - mean| / sd against G crit = (n - 1)/sqrt(n) x sqrt(t^2 / (n - 2 + t^2)), t the upper alpha/(2n) quantile of Student's t with n - 2 degrees of freedom, repeated for up to r outliers (Rosner's generalized ESD).",
    "Trendlines are ordinary least-squares polynomials of the selected degree on the raw daily output.",
  ]);

  r.frame(`Generated ${generated.toLocaleString("en-GB")} | ${ds.source === "sheet" ? "Live data: Mining Ops Simulator spreadsheet" : "Offline sample data"}`);
  doc.save(`WY-mining-report_${first}_${last}.pdf`);
}

