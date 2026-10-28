const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const parts = (iso: string) => iso.split("-").map(Number) as [number, number, number];

/** "Nov 2" */
export function shortDate(iso: string): string {
  const [, m, d] = parts(iso);
  return `${MONTHS[m - 1]} ${d}`;
}

/** "2 Nov 2099" */
export function longDate(iso: string): string {
  const [y, m, d] = parts(iso);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "10 Nov to 12 Nov 2099", or a single date. */
export function dateRange(a: string, b: string): string {
  if (a === b) return longDate(a);
  const [ya] = parts(a);
  const [yb] = parts(b);
  return ya === yb ? `${longDate(a).replace(` ${ya}`, "")} to ${longDate(b)}` : `${longDate(a)} to ${longDate(b)}`;
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const nf = (d: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const f0 = nf(0);
const f1 = nf(1);
const f2 = nf(2);

export const num0 = (x: number) => (Number.isFinite(x) ? f0.format(x) : "n/a");
export const num1 = (x: number) => (Number.isFinite(x) ? f1.format(x) : "n/a");
export const num2 = (x: number) => (Number.isFinite(x) ? f2.format(x) : "n/a");

/** Signed percent with a real minus sign: "+39%", "-58%". */
export function pct(x: number, digits = 0): string {
  if (!Number.isFinite(x)) return "n/a";
  const s = Math.abs(x).toFixed(digits);
  return (x >= 0 ? "+" : "−") + s + "%";
}

export function clock(d: Date): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
