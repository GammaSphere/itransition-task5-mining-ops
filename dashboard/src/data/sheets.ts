import type { GeneratorEvent } from "../analysis/detect";

export interface MineSeries {
  name: string;
  values: number[];
}

export interface GeneratorParams {
  start: string;
  days: number;
  mines: string[];
  distribution: string;
  params: { label: string; value: number | null }[];
  smoothing: number | null;
  correlation: number | null;
  seed: number | null;
  weekday: number[];
  growth: number | null;
  trend: string;
}

export interface Dataset {
  source: "sheet" | "sample";
  sheetId: string | null;
  fetchedAt: Date;
  dates: string[];
  mines: MineSeries[];
  events: GeneratorEvent[];
  params: GeneratorParams | null;
  /** Set when the dashboard fell back to the offline sample. */
  warning?: string;
}

// The public generator spreadsheet (anyone with the link can edit). Override with ?sheet=<id or URL>.
export const DEFAULT_SHEET_ID = "";

type Cell = { v: unknown; f?: string } | null;
interface GvizTable {
  cols: { label: string; type: string }[];
  rows: { c: Cell[] }[];
}

export class SheetError extends Error {}

export function parseSheetId(input: string): string | null {
  const s = input.trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : null;
}

let useProxy = false;
let reqId = 0;

async function gviz(id: string, q: { sheet: string; range?: string; headers: number }): Promise<GvizTable> {
  const params = new URLSearchParams({ tqx: `out:json;reqId:${++reqId}`, sheet: q.sheet, headers: String(q.headers) });
  if (q.range) params.set("range", q.range);
  params.set("_", String(Date.now())); // defeat intermediate caches
  const direct = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?${params}`;
  const proxied = `/gsheets/${id}/gviz/tq?${params}`;
  let text: string;
  try {
    text = await (await fetch(useProxy ? proxied : direct, { cache: "no-store" })).text();
  } catch (e) {
    if (useProxy) throw new SheetError("Network error while reading the spreadsheet.");
    useProxy = true; // the browser blocked the direct call (CORS or network): go through the site's proxy
    text = await (await fetch(proxied, { cache: "no-store" })).text();
  }
  const a = text.indexOf("setResponse(");
  if (a < 0) {
    throw new SheetError("The spreadsheet is not publicly readable. In Google Sheets choose Share, then General access: Anyone with the link.");
  }
  const json = JSON.parse(text.slice(a + "setResponse(".length, text.lastIndexOf(")")));
  if (json.status === "error") {
    const msg = json.errors?.map((e: { detailed_message?: string; message?: string }) => e.detailed_message || e.message).join("; ");
    throw new SheetError(`Google Sheets returned an error: ${msg || "unknown error"}`);
  }
  return json.table as GvizTable;
}

function toIso(v: unknown): string | null {
  if (typeof v === "string") {
    const m = v.match(/^Date\((\d+),(\d+),(\d+)/);
    if (m) return isoFromParts(+m[1], +m[2], +m[3]);
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  if (typeof v === "number" && v > 20000 && v < 200000) {
    // spreadsheet serial day (1899-12-30 epoch), when the column has no date format
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  }
  return null;
}

const isoFromParts = (y: number, m0: number, d: number) => new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);
const num = (c: Cell) => (c && typeof c.v === "number" ? c.v : null);
const str = (c: Cell) => (c && c.v !== null && c.v !== undefined ? String(c.v).trim() : "");

export function parseData(t: GvizTable): { dates: string[]; mines: MineSeries[] } {
  const labels = t.cols.map((c) => (c.label || "").trim());
  const dateCol = labels.findIndex((l) => l.toLowerCase() === "date");
  if (dateCol < 0) throw new SheetError('The Data sheet has no "Date" column.');
  const mineCols = labels.map((l, i) => ({ l, i })).filter(({ l, i }) => i !== dateCol && l && l.toLowerCase() !== "total");
  const dates: string[] = [];
  const cols = mineCols.map(() => [] as number[]);
  for (const row of t.rows) {
    const d = toIso(row.c[dateCol]?.v);
    if (!d) continue;
    dates.push(d);
    mineCols.forEach(({ i }, k) => cols[k].push(num(row.c[i]) ?? 0));
  }
  if (!dates.length) throw new SheetError("The Data sheet has no rows. Check the start date and days count in the generator.");
  return { dates, mines: mineCols.map(({ l }, k) => ({ name: l, values: cols[k] })) };
}

function parseEvents(t: GvizTable): GeneratorEvent[] {
  const out: GeneratorEvent[] = [];
  t.rows.forEach((row, k) => {
    const day = toIso(row.c[0]?.v);
    const factor = num(row.c[2]);
    if (!day || factor === null) return;
    out.push({
      id: k + 1,
      day,
      duration: num(row.c[1]) ?? 1,
      factor,
      probability: num(row.c[3]),
      mines: num(row.c[4]),
      shape: str(row.c[5]) || "Bell",
      affected: str(row.c[6]).split(",").map((s) => s.trim()).filter((s) => s && s !== "none"),
    });
  });
  return out;
}

async function readParams(id: string): Promise<GeneratorParams | null> {
  try {
    const one = (range: string) => gviz(id, { sheet: "Generator", range, headers: 0 }).then((t) => t.rows[0]?.c ?? []);
    const [range, mines, labels, random, weekday, growth] = await Promise.all(
      ["B4:C4", "B5:I5", "C6:E6", "B7:H7", "B10:H10", "B11:D11"].map(one),
    );
    const labelsText = labels.map(str);
    return {
      start: toIso(range[0]?.v) ?? "",
      days: num(range[1]) ?? 0,
      mines: mines.map(str).filter(Boolean),
      distribution: str(random[0]),
      params: [0, 1, 2]
        .map((k) => ({ label: labelsText[k] ?? "", value: num(random[k + 1]) }))
        .filter((p) => p.label),
      smoothing: num(random[4]),
      correlation: num(random[5]),
      seed: num(random[6]),
      weekday: weekday.map((c) => num(c) ?? 1),
      growth: num(growth[0]),
      trend: str(growth[2]),
    };
  } catch {
    return null; // parameters are informational; the analysis does not depend on them
  }
}

export async function loadSheet(id: string): Promise<Dataset> {
  const [data, events, params] = await Promise.all([
    gviz(id, { sheet: "Data", headers: 1 }).then(parseData),
    gviz(id, { sheet: "Generator", range: "B13:H20", headers: 0 }).then(parseEvents).catch(() => []),
    readParams(id),
  ]);
  return { source: "sheet", sheetId: id, fetchedAt: new Date(), ...data, events, params };
}

export async function loadSample(warning?: string): Promise<Dataset> {
  const res = await fetch(`${import.meta.env.BASE_URL}sample-data.json`);
  const s = await res.json();
  return {
    source: "sample",
    sheetId: null,
    fetchedAt: new Date(),
    dates: s.dates,
    mines: Object.entries(s.mines as Record<string, number[]>).map(([name, values]) => ({ name, values })),
    events: s.events,
    params: null,
    warning,
  };
}
