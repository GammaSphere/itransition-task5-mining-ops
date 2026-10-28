import "./styles.css";
import { DEFAULT_DETECTION, TESTS, type DetectionSettings, type Episode, type SeriesAnalysis } from "./analysis/detect";
import { runAnalysis, TOTAL, type Analysis } from "./analysis/run";
import { DEFAULT_SHEET_ID, loadSample, loadSheet, parseSheetId, SheetError, type Dataset } from "./data/sheets";
import { boxOption, echarts, focusOption, mainOption, matrixOption, PALETTE, T, weekOption, type ChartType } from "./ui/charts";
import { clock, dateRange, esc, longDate, num0, num1, num2, pct, shortDate, WEEKDAYS } from "./ui/format";

// State ------------------------------------------------------------------------------------------

export interface ViewSettings {
  chartType: ChartType;
  showTrend: boolean;
  showTotal: boolean;
  hidden: string[];
  focus: string;
}

interface Settings {
  view: ViewSettings;
  detect: DetectionSettings;
  sheetId: string | null;
  useSample: boolean;
  colors: Record<string, number>;
}

const STORE = "wy-mining-dashboard/v1";
const defaults = (): Settings => ({
  view: { chartType: "line", showTrend: true, showTotal: false, hidden: [], focus: "" },
  detect: { ...DEFAULT_DETECTION },
  sheetId: null,
  useSample: false,
  colors: {},
});

function loadSettings(): Settings {
  const d = defaults();
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || "{}");
    return { ...d, ...s, view: { ...d.view, ...s.view }, detect: { ...d.detect, ...s.detect }, colors: { ...s.colors } };
  } catch {
    return d;
  }
}
const save = () => {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch {
    /* private mode: settings live for this visit only */
  }
};

const settings = loadSettings();
const url = new URL(location.href);
const urlSheet = url.searchParams.get("sheet");
if (urlSheet && parseSheetId(urlSheet)) {
  settings.sheetId = parseSheetId(urlSheet);
  settings.useSample = false;
}
if (url.searchParams.get("source") === "sample") settings.useSample = true;

let dataset: Dataset | null = null;
let analysis: Analysis | null = null;
let fingerprint = "";
let lastChange: Date | null = null;
let busy = false;
let selectedEpisode: string | null = null;
let pending = false;
const episodeKey = (e: Episode) => `${e.series}|${e.start}`;

const sheetId = () => settings.sheetId || DEFAULT_SHEET_ID || null;

/** A mine keeps its palette slot across refreshes and filters ("colour follows the entity"). */
function colorFor(name: string): string {
  if (name === TOTAL) return T.ink;
  if (settings.colors[name] === undefined) {
    const used = new Set(Object.values(settings.colors));
    let slot = 0;
    while (used.has(slot) && slot < PALETTE.length - 1) slot++;
    settings.colors[name] = slot;
  }
  return PALETTE[settings.colors[name] % PALETTE.length];
}
const colorMap = () => new Map([...(analysis?.mines ?? []).map((a) => [a.name, colorFor(a.name)] as const), [TOTAL, T.ink] as const]);

// DOM helpers ------------------------------------------------------------------------------------

const $ = <E extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as E;
const charts = new Map<string, ReturnType<typeof echarts.init>>();
function chart(id: string) {
  let c = charts.get(id);
  if (!c) {
    c = echarts.init($(id), undefined, { renderer: "canvas" });
    charts.set(id, c);
    new ResizeObserver(() => c!.resize()).observe($(id));
  }
  return c;
}

function toast(msg: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// Data -----------------------------------------------------------------------------------------------

async function refresh(manual = false) {
  if (busy) {
    pending = true;
    return;
  }
  busy = true;
  renderSource();
  try {
    const id = sheetId();
    let ds: Dataset;
    if (settings.useSample || !id) {
      ds = await loadSample(id ? undefined : "No spreadsheet is configured yet, so the dashboard shows the offline sample.");
    } else {
      try {
        ds = await loadSheet(id);
      } catch (e) {
        const reason = e instanceof SheetError ? e.message : "The spreadsheet could not be reached.";
        if (dataset?.source === "sheet" && dataset.sheetId === id) {
          // Keep the live data already on screen; a passing network error is not a data change.
          dataset = { ...dataset, warning: `${reason} Showing the data read at ${clock(dataset.fetchedAt)}.` };
          if (manual) toast("The spreadsheet could not be read. Showing the last data.");
          return;
        }
        ds = await loadSample(`${reason} Showing the offline sample instead.`);
      }
    }
    const fp = JSON.stringify([ds.dates, ds.mines, ds.events]);
    if (fingerprint && fp !== fingerprint) {
      lastChange = new Date();
      if (!manual) toast("The spreadsheet changed. Dashboard updated.");
    }
    fingerprint = fp;
    dataset = ds;
    recompute();
    if (manual) toast(ds.source === "sheet" ? "Data refreshed from the spreadsheet" : "Showing the offline sample");
  } finally {
    busy = false;
    renderSource();
    $("app").classList.remove("loading");
    if (pending) {
      pending = false;
      refresh(true);
    }
  }
}

function recompute() {
  if (!dataset) return;
  analysis = runAnalysis(dataset, settings.detect);
  const current = new Set(analysis.mines.map((a) => a.name));
  settings.colors = Object.fromEntries(Object.entries(settings.colors).filter(([k]) => current.has(k)));
  settings.view.hidden = settings.view.hidden.filter((h) => current.has(h));
  const names = [...analysis.mines.map((a) => a.name), TOTAL];
  if (!names.includes(settings.view.focus)) settings.view.focus = names[0];
  if (selectedEpisode !== null && !analysis.episodes.some((e) => episodeKey(e) === selectedEpisode)) selectedEpisode = null;
  save();
  renderAll();
}

// Rendering ----------------------------------------------------------------------------------------

function renderSource() {
  const el = $("source");
  const ds = dataset;
  const live = ds?.source === "sheet";
  const dot = `<span class="dot ${live ? "" : "offline"} ${busy ? "busy" : ""}" aria-hidden="true"></span>`;
  const what = busy && !ds ? "Connecting to the spreadsheet" : live ? "<strong>Live</strong> from the generator spreadsheet" : "<strong>Offline sample</strong>";
  const when = ds ? `<span class="when">read at ${clock(ds.fetchedAt)}</span>` : "";
  const changed = lastChange ? `<span class="changed">changed ${clock(lastChange)}</span>` : "";
  el.innerHTML = `${dot}<span>${what}</span>${when}${changed}`;
  const banner = $("banner");
  banner.hidden = !ds?.warning;
  banner.textContent = ds?.warning ?? "";
  const link = $<HTMLAnchorElement>("sheet-link");
  const id = sheetId();
  link.href = id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : "#";
}

function renderAll() {
  if (!analysis || !dataset) return;
  renderReadout();
  renderControls();
  renderMain();
  renderDetectForm();
  renderStats();
  renderAnomalies();
  renderFocus();
  renderDistribution();
}

function renderReadout() {
  const a = analysis!;
  const t = a.total;
  const peak = t.values.indexOf(Math.max(...t.values));
  const drops = a.episodes.filter((e) => e.dir < 0).length;
  const spikes = a.episodes.length - drops;
  const cov = a.coverage;
  const cells = [
    ["Period", dateRange(a.dates[0], a.dates[a.dates.length - 1]).replace(/ \d{4}$/, ""), `${a.dates.length} days, ${a.dates[0].slice(0, 4)}`],
    ["Mines", String(a.mines.length), a.mines.map((m) => m.name).join(", ")],
    ["Total output", `${num0(t.summary.sum)} t`, `${num1(t.summary.mean)} t per day on average`],
    ["Underlying growth", `<span class="${a.growth >= 0 ? "up" : "crit"}">${pct(a.growth * 100, 1)}</span> per day`, "trend of total output, weekly pattern removed"],
    ["Peak day", `${num0(t.values[peak])} t`, longDate(a.dates[peak])],
    ["Anomalies", `<span class="${a.episodes.length ? "crit" : ""}">${a.episodes.length}</span> episode${a.episodes.length === 1 ? "" : "s"}`,
      `${drops} drop${drops === 1 ? "" : "s"}, ${spikes} spike${spikes === 1 ? "" : "s"}` + (cov && cov.pairs ? `; ${cov.detected} of ${cov.pairs} configured event hits found` : "")],
  ];
  $("readout").innerHTML = cells.map(([k, v, s]) => `<div><dl><dt>${k}</dt><dd>${v}<small>${esc(s)}</small></dd></dl></div>`).join("");
}

function seg(id: string, options: [string, string][], current: string, onPick: (v: string) => void, disabled = false) {
  const el = $(id);
  el.setAttribute("aria-disabled", String(disabled));
  el.innerHTML = options.map(([v, label]) => `<button type="button" role="radio" aria-checked="${v === current}" data-v="${v}">${label}</button>`).join("");
  el.onclick = (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b) onPick(b.dataset.v!);
  };
}

function renderControls() {
  const v = settings.view;
  seg("chart-type", [["line", "Line"], ["bar", "Bar"], ["stacked-bar", "Stacked bars"], ["stacked-area", "Stacked area"]], v.chartType, (x) => {
    v.chartType = x as ChartType;
    save();
    renderControls();
    renderMain();
  });
  seg("degree", ["1", "2", "3", "4"].map((d) => [d, d] as [string, string]), String(settings.detect.degree), (x) => {
    settings.detect.degree = Number(x);
    recompute();
  });
  const trend = $<HTMLInputElement>("show-trend");
  trend.checked = v.showTrend;
  trend.onchange = () => {
    v.showTrend = trend.checked;
    save();
    renderMain();
  };
  const chips = [...analysis!.mines.map((a) => a.name), TOTAL];
  $("chips").innerHTML = chips
    .map((n) => {
      const on = n === TOTAL ? v.showTotal : !v.hidden.includes(n);
      return `<button type="button" class="chip" aria-pressed="${on}" data-n="${esc(n)}" style="--c:${colorFor(n)}"><span class="sw"></span>${esc(n)}</button>`;
    })
    .join("");
  $("chips").onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".chip");
    if (!b) return;
    const n = b.dataset.n!;
    if (n === TOTAL) v.showTotal = !v.showTotal;
    else v.hidden = v.hidden.includes(n) ? v.hidden.filter((x) => x !== n) : [...v.hidden, n];
    save();
    renderControls();
    renderMain();
  };
}

function mainContext(print = false) {
  const a = analysis!;
  const v = settings.view;
  return {
    dates: a.dates,
    mines: a.mines.filter((m) => !v.hidden.includes(m.name)),
    total: a.total,
    colors: colorMap(),
    chartType: v.chartType,
    showTrend: v.showTrend,
    showTotal: v.showTotal,
    print,
  };
}

function renderMain() {
  chart("chart-main").setOption(mainOption(mainContext()), true);
  const d = settings.detect.degree;
  const stacked = settings.view.chartType.startsWith("stacked");
  $("main-note").textContent =
    (settings.view.showTrend ? `Dashed lines: least-squares polynomial trend of degree ${d}${stacked ? " for the total" : ""}. ` : "") +
    `Red triangles mark anomalies (▲ spike, ▼ drop) found by at least ${settings.detect.minTests} of the 4 tests.`;
}

interface FieldDef {
  key: keyof DetectionSettings;
  label: string;
  type: "number" | "select" | "check";
  min?: number;
  max?: number;
  step?: number;
  options?: [string, string][];
}

const GROUPS: { title: string; test?: (typeof TESTS)[number]["id"]; fields: FieldDef[]; desc?: string }[] = [
  {
    title: "What the tests look at",
    fields: [
      { key: "detrend", label: "Remove the trend", type: "check" },
      { key: "seasonal", label: "Remove the weekly pattern", type: "check" },
    ],
    desc: "On: tests use each day's deviation from its expected level (robust log-linear fit of trend and weekdays). Off: raw daily output.",
  },
  { title: "IQR rule", test: "iqr", fields: [{ key: "iqrK", label: "Fence k (x IQR)", type: "number", min: 0.5, max: 5, step: 0.1 }] },
  {
    title: "Z-score",
    test: "z",
    fields: [
      { key: "zThreshold", label: "Threshold |z| >", type: "number", min: 1, max: 6, step: 0.1 },
      { key: "zRobust", label: "Robust (median and MAD)", type: "check" },
    ],
  },
  {
    title: "Distance from moving average",
    test: "ma",
    fields: [
      { key: "maWindow", label: "Window, days", type: "number", min: 2, max: 60, step: 1 },
      { key: "maPct", label: "Distance, %", type: "number", min: 1, max: 300, step: 1 },
      { key: "maMode", label: "Window", type: "select", options: [["trailing", "Trailing"], ["centered", "Centered"]] },
    ],
  },
  {
    title: "Grubbs' test",
    test: "grubbs",
    fields: [
      { key: "grubbsAlpha", label: "Significance α", type: "number", min: 0.001, max: 0.2, step: 0.005 },
      { key: "grubbsMax", label: "Max outliers r", type: "number", min: 1, max: 50, step: 1 },
    ],
    desc: "Generalized (Rosner) procedure, so clustered anomalies don't mask each other. r = 1 is the classic test.",
  },
  {
    title: "Anomaly",
    fields: [{ key: "minTests", label: "Tests that must agree", type: "select", options: [["1", "1 of 4"], ["2", "2 of 4"], ["3", "3 of 4"], ["4", "All 4"]] }],
  },
];

function renderDetectForm() {
  const form = $<HTMLFormElement>("detect-form");
  const d = settings.detect;
  const a = analysis!;
  const counts = (t: string) => [...a.mines, a.total].reduce((acc, s) => acc + s.counts[t as keyof SeriesAnalysis["counts"]], 0);
  const raw = !d.detrend && !d.seasonal;
  if (!form.dataset.built) {
    form.innerHTML =
      GROUPS.map((g) => `<fieldset><legend>${g.title}${g.test ? `<span class="count" data-count="${g.test}"></span>` : ""}</legend>${g.fields
        .map((f) => {
          if (f.type === "check") return `<label class="check"><input type="checkbox" name="${f.key}" /> ${f.label}</label>`;
          if (f.type === "select") {
            return `<label class="field">${f.label}<select name="${f.key}">${f.options!.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>`;
          }
          return `<label class="field">${f.label}<input type="number" name="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" inputmode="decimal" /></label>`;
        })
        .join("")}${g.desc ? `<p class="desc">${g.desc}</p>` : ""}</fieldset>`).join("") +
      `<button type="button" class="btn ghost reset" id="btn-reset">Reset to defaults</button>`;
    form.dataset.built = "1";
    form.addEventListener("change", (e) => {
      const el = e.target as HTMLInputElement | HTMLSelectElement;
      const key = el.name as keyof DetectionSettings;
      const f = GROUPS.flatMap((g) => g.fields).find((x) => x.key === key)!;
      const target = settings.detect as unknown as Record<string, unknown>;
      if (f.type === "check") target[key] = (el as HTMLInputElement).checked;
      else if (key === "maMode") target[key] = el.value;
      else {
        const v = Number(el.value);
        if (!Number.isFinite(v)) return;
        target[key] = Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, v));
      }
      recompute();
    });
    $("btn-reset").onclick = () => {
      settings.detect = { ...DEFAULT_DETECTION };
      recompute();
    };
  }
  for (const f of GROUPS.flatMap((g) => g.fields)) {
    const el = form.elements.namedItem(f.key) as HTMLInputElement | HTMLSelectElement;
    if (f.type === "check") (el as HTMLInputElement).checked = Boolean(d[f.key]);
    else if (document.activeElement !== el) el.value = String(d[f.key]);
  }
  form.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
    const n = counts(el.dataset.count!);
    el.textContent = `${n} day${n === 1 ? "" : "s"} flagged`;
  });
  form.querySelector<HTMLElement>("fieldset p.desc")!.textContent = raw
    ? "Tests run on the raw daily output. Turn either option on to test each day against its expected level instead."
    : `Tests use each day's relative deviation from its expected level (robust log-linear fit${d.detrend ? `, degree-${d.degree} trend` : ""}${d.seasonal ? ", weekday profile" : ""}).`;
}

function renderStats() {
  const a = analysis!;
  const head = `<thead><tr class="group"><th class="l"></th><th colspan="8">Daily output, t</th><th colspan="5">Days flagged</th></tr>
    <tr><th class="l">Series</th><th>Mean</th><th>Std dev</th><th>Median</th><th>Q1</th><th>Q3</th><th>IQR</th><th>Min</th><th>Max</th>
    ${TESTS.map((t) => `<th title="${t.name}">${t.short === "G" ? "Grubbs" : t.short}</th>`).join("")}<th>Anomalies</th></tr></thead>`;
  const row = (s: SeriesAnalysis, total = false) => {
    const m = s.summary;
    const c = (n: number) => `<td class="${n ? "" : "zero"}">${n}</td>`;
    return `<tr class="${total ? "total" : ""}"><td class="l name"><span class="swatch" style="--c:${colorFor(s.name)}"></span>${esc(s.name)}</td>
      <td>${num1(m.mean)}</td><td>${num1(m.sd)}</td><td>${num1(m.median)}</td><td>${num1(m.q1)}</td><td>${num1(m.q3)}</td><td>${num1(m.iqr)}</td>
      <td>${num1(m.min)}</td><td>${num1(m.max)}</td>${TESTS.map((t) => c(s.counts[t.id])).join("")}${c(s.anomalies.length)}</tr>`;
  };
  $("stats-table").innerHTML = `${head}<tbody>${a.mines.map((s) => row(s)).join("")}${row(a.total, true)}</tbody>`;
}

export function eventLabel(e: Episode["match"]): string {
  if (!e) return "";
  const shape = e.shape === "Flat" ? "flat" : "bell";
  return `Event #${e.id}: x${num2(e.factor)} from ${shortDate(e.day)}, ${e.duration} d, ${shape}`;
}

function renderAnomalies() {
  const a = analysis!;
  const cov = a.coverage;
  $("anom-summary").textContent = a.episodes.length
    ? `Consecutive anomalous days of a series form one episode. ` +
      (cov ? `${cov.matchedEpisodes} of ${cov.mineEpisodes} mine episodes match an event configured in the generator; ${cov.detected} of ${cov.pairs} configured event hits were found.` : "")
    : "";
  if (!a.episodes.length) {
    $("anom-table").innerHTML = `<tbody><tr><td class="empty l">No day is flagged by ${settings.detect.minTests} or more tests. Lower the thresholds or the number of tests that must agree.</td></tr></tbody>`;
    return;
  }
  const head = `<thead><tr><th class="l">ID</th><th class="l">Series</th><th class="l">Type</th><th class="l">Dates</th><th>Days</th>
    <th>Peak, t</th><th>Expected, t</th><th>Deviation</th><th class="l">Tests</th><th class="l">Generator event</th></tr></thead>`;
  const rows = a.episodes.map((e) => {
    const days = e.end - e.start + 1;
    return `<tr class="clickable ${episodeKey(e) === selectedEpisode ? "selected" : ""}" data-id="${e.id}" tabindex="0">
      <td class="l">A${e.id}</td>
      <td class="l name"><span class="swatch" style="--c:${colorFor(e.series)}"></span>${esc(e.series)}</td>
      <td class="l"><span class="dir">${e.dir > 0 ? "▲ Spike" : "▼ Drop"}</span></td>
      <td class="l">${dateRange(a.dates[e.start], a.dates[e.end])}</td>
      <td>${days}</td><td>${num1(e.peakValue)}</td><td>${num1(e.peakExpected)}</td><td>${pct(e.peakDevPct)}</td>
      <td class="l">${e.tests.map((t) => `<span class="tag">${TESTS.find((x) => x.id === t)!.short === "G" ? "Grubbs" : TESTS.find((x) => x.id === t)!.short}</span>`).join("")}</td>
      <td class="l">${e.match ? `<span class="match">${esc(eventLabel(e.match))}</span>` : `<span class="nomatch">${dataset!.events.length ? "none configured" : "events unknown"}</span>`}</td></tr>`;
  });
  $("anom-table").innerHTML = `${head}<tbody>${rows.join("")}</tbody>`;
  const pick = (tr: HTMLElement | null) => {
    if (!tr) return;
    const ep = a.episodes.find((x) => x.id === Number(tr.dataset.id))!;
    selectedEpisode = episodeKey(ep);
    settings.view.focus = ep.series;
    renderAnomalies();
    renderFocus();
    $("h-focus").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    chart("chart-focus").dispatchAction({ type: "showTip", seriesIndex: 4, dataIndex: ep.peak });
  };
  const tbody = $("anom-table").querySelector("tbody")!;
  tbody.onclick = (e) => pick((e.target as HTMLElement).closest("tr"));
  tbody.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick((e.target as HTMLElement).closest("tr"));
    }
  };
}

function focusSeries(): SeriesAnalysis {
  const a = analysis!;
  return [...a.mines, a.total].find((s) => s.name === settings.view.focus) ?? a.mines[0];
}

function renderFocus() {
  const a = analysis!;
  const s = focusSeries();
  const names = [...a.mines.map((m) => m.name), TOTAL];
  $("focus-tabs").innerHTML = names
    .map((n) => `<button type="button" role="tab" aria-selected="${n === s.name}" data-n="${esc(n)}">${esc(n)}</button>`)
    .join("");
  $("focus-tabs").onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!b) return;
    settings.view.focus = b.dataset.n!;
    save();
    renderFocus();
  };
  const d = settings.detect;
  chart("chart-focus").setOption(focusOption(s, a.dates, colorFor(s.name), d.maWindow), true);
  chart("chart-matrix").setOption(matrixOption(s, a.dates, d.minTests), true);
  const m = s.summary;
  const prof = a.profiles.get(s.name) ?? [];
  const basisUnit = s.basisLabel === "daily output" ? "t" : "";
  const fmtB = (x: number) => (basisUnit ? `${num1(x)} t` : pct(x * 100, 1));
  $("focus-side").innerHTML = `
    <h3>${esc(s.name)}</h3>
    <dl>
      <dt>Mean</dt><dd>${num1(m.mean)} t</dd><dt>Std deviation</dt><dd>${num1(m.sd)} t</dd>
      <dt>Median</dt><dd>${num1(m.median)} t</dd><dt>Interquartile range</dt><dd>${num1(m.iqr)} t</dd>
      <dt>Range</dt><dd>${num1(m.min)} to ${num1(m.max)} t</dd><dt>Trend fit R² (degree ${s.trend.degree})</dt><dd>${num2(s.trend.r2)}</dd>
    </dl>
    <h3>Test thresholds</h3>
    <dl>
      <dt>IQR fences</dt><dd>${fmtB(s.fences.lo)} / ${fmtB(s.fences.hi)}</dd>
      <dt>Z: mean, sd</dt><dd>${fmtB(s.zStats.mean)}, ${fmtB(s.zStats.sd)}</dd>
      <dt>Grubbs critical G</dt><dd>${num2(s.grubbsCrit)}</dd>
      <dt>Moving average</dt><dd>${d.maWindow} d ${d.maMode}, ±${d.maPct}%</dd>
    </dl>
    <p>Thresholds apply to the ${esc(s.basisLabel)}.</p>
    <h3>Weekly pattern</h3>
    <dl>${WEEKDAYS.map((w, k) => `<dt>${w}</dt><dd>${prof[k] !== undefined ? (prof[k] * 100).toFixed(0) + "%" : "n/a"}</dd>`).join("")}</dl>
    <p>Output on each weekday relative to an average day, estimated from the data.</p>`;
}

function renderDistribution() {
  const a = analysis!;
  const colors = colorMap();
  chart("chart-box").setOption(boxOption(a.mines, colors, settings.detect.iqrK), true);
  chart("chart-week").setOption(weekOption(a.mines, a.profiles, colors), true);
}

// Wiring -----------------------------------------------------------------------------------------------

$("btn-refresh").onclick = () => refresh(true);

let timer: number | undefined;
const auto = $<HTMLInputElement>("auto-refresh");
auto.onchange = () => {
  clearInterval(timer);
  if (auto.checked) timer = window.setInterval(() => refresh(false), 30000);
};

$("btn-pdf").onclick = async () => {
  if (!analysis || !dataset) return;
  const btn = $<HTMLButtonElement>("btn-pdf");
  btn.disabled = true;
  btn.textContent = "Preparing report";
  try {
    const { buildReport } = await import("./report/pdf");
    await buildReport({ dataset, analysis, detect: settings.detect, view: settings.view, colors: colorMap(), sheetId: sheetId() });
    toast("Report downloaded");
  } catch (e) {
    console.error(e);
    toast("The report could not be created. See the browser console for details.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Download PDF report";
  }
};

const dialog = $<HTMLDialogElement>("source-dialog");
$("btn-source").onclick = () => {
  const id = sheetId();
  $<HTMLInputElement>("source-input").value = id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : "";
  dialog.returnValue = "";
  dialog.showModal();
};
$("source-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    dialog.close("ok");
  }
});
dialog.addEventListener("close", () => {
  if (dialog.returnValue === "sample") {
    settings.useSample = true;
  } else if (dialog.returnValue === "ok") {
    const id = parseSheetId($<HTMLInputElement>("source-input").value);
    if (!id) {
      toast("That doesn't look like a Google Sheets link.");
      return;
    }
    settings.sheetId = id;
    settings.useSample = false;
  } else return;
  save();
  fingerprint = "";
  refresh(true);
});

refresh(false);
