// Smoke test in a real browser: loads the dashboard, takes screenshots, downloads the PDF report.
// Usage: node scripts/e2e.mjs [baseUrl]   (default http://localhost:5173/?source=sample)
import { chromium } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] || "http://localhost:5173/?source=sample";
const out = process.env.E2E_OUT || "e2e-out";
mkdirSync(out, { recursive: true });
const exe = process.env.CHROME_PATH || [
  join(homedir(), "AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe"),
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find(existsSync);

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector("#stats-table tbody tr");
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/desktop.png`, fullPage: true });
for (const t of ["bar", "stacked-bar", "stacked-area"]) {
  await page.click(`#chart-type button[data-v="${t}"]`);
  await page.waitForTimeout(1600);
  await page.locator(".overview").screenshot({ path: `${out}/main-${t}.png` });
}
await page.click(`#chart-type button[data-v="line"]`);
const [download] = await Promise.all([page.waitForEvent("download", { timeout: 90000 }), page.click("#btn-pdf")]);
await download.saveAs(`${out}/${download.suggestedFilename()}`);
console.log("pdf:", download.suggestedFilename());
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/mobile.png`, fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
console.log("mobile horizontal overflow px:", overflow);
console.log("errors:", errors.length ? errors : "none");
await browser.close();
