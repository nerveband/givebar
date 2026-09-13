// Build the end-of-night donor report: workbook, interactive HTML, and PDF.
//
//   bun reports/build-report.ts            # all three into reports/out/
//   bun reports/build-report.ts --no-pdf   # skip Chromium
//
// Inputs (see reports/report.config.json and reports/README.md):
//   reports/data/givebar-prod.sqlite   reports/pull-givebar.sh
//   reports/data/qgiv-history.json     reports/pull-qgiv.ts (via secret-gate exec)
//   reports/data/bloomerang.json       reports/pull-bloomerang.ts (optional)
//   MASTER workbook                    path in config
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { buildReport, type Config } from "./lib/data";
import { writeWorkbook } from "./lib/xlsx";
import { renderHTML } from "./lib/html";

const root = join(import.meta.dir, "..");
process.chdir(root);
const config = JSON.parse(readFileSync("reports/report.config.json", "utf8")) as Config;
for (const [name, path] of Object.entries(config.inputs)) {
  if (!existsSync(path) && name !== "bloomerang") { console.error(`Missing input ${name}: ${path}`); process.exit(1); }
}
ensureFonts();
mkdirSync("reports/out", { recursive: true });
const base = join("reports/out", config.output_basename);

const report = await buildReport(config);
console.log(`ledger: ${report.stats.active_count} active gifts, ${(report.stats.total_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} · ${report.donors.length} households · Bloomerang ${report.bloomerang.connected ? "connected" : "not connected"}`);

writeFileSync(`${base}.json`, JSON.stringify({ generated_at: report.generated_at, stats: report.stats, takeaways: report.takeaways, milestones: report.milestones }, null, 2));
await writeWorkbook(report, `${base}.xlsx`);
console.log(`wrote ${base}.xlsx`);
writeFileSync(`${base}.html`, renderHTML(report));
console.log(`wrote ${base}.html`);

if (!process.argv.includes("--no-pdf")) {
  const chromium = findChromium();
  if (!chromium) console.error("No Chromium found (looked in ~/.cache/ms-playwright and PATH); skipped the PDF.");
  else {
    const proc = Bun.spawn([chromium, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer", "--run-all-compositor-stages-before-draw", "--virtual-time-budget=8000", `--print-to-pdf=${join(root, `${base}.pdf`)}`, `file://${join(root, `${base}.html`)}`], { stdout: "ignore", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) console.error(`Chromium exited ${code}: ${await new Response(proc.stderr).text()}`);
    else console.log(`wrote ${base}.pdf`);
  }
}


/** The Brandon/Jakarta/Space Mono files are licensed and gitignored; copy them from the booklet release on this machine when absent. */
function ensureFonts(): void {
  const dir = join(root, "reports", "theme", "fonts");
  const source = "/home/nerveband/state/booklet-r22-spacing-release/versions/r16/assets";
  const files: Record<string, string> = { "Brandon_reg.otf": "fonts/Brandon_reg.otf", "Brandon_med.otf": "fonts/Brandon_med.otf", "Brandon_bld.otf": "fonts/Brandon_bld.otf", "Brandon_blk.otf": "fonts/Brandon_blk.otf", "Brandon_light.otf": "fonts/Brandon_light.otf", "plus-jakarta-sans-400.ttf": "plus-jakarta-sans-400.ttf", "plus-jakarta-sans-400-italic.ttf": "plus-jakarta-sans-400-italic.ttf", "plus-jakarta-sans-600.ttf": "plus-jakarta-sans-600.ttf", "plus-jakarta-sans-700.ttf": "plus-jakarta-sans-700.ttf", "space-mono-400.ttf": "space-mono-400.ttf", "space-mono-700.ttf": "space-mono-700.ttf" };
  mkdirSync(dir, { recursive: true });
  for (const [name, rel] of Object.entries(files)) {
    if (existsSync(join(dir, name))) continue;
    const from = join(source, rel);
    if (!existsSync(from)) { console.error(`Missing font ${name}; copy it into reports/theme/fonts (see reports/README.md).`); process.exit(1); }
    writeFileSync(join(dir, name), readFileSync(from));
  }
}
function findChromium(): string | null {
  const home = process.env.HOME || "";
  const cache = join(home, ".cache", "ms-playwright");
  if (existsSync(cache)) {
    const dirs = readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const dir of dirs) for (const sub of ["chrome-linux64", "chrome-linux"]) { const bin = join(cache, dir, sub, "chrome"); if (existsSync(bin)) return bin; }
  }
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    const found = Bun.which(name); if (found) return found;
  }
  return null;
}
