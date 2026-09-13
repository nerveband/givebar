// Single-file interactive report. Screen: a left-aligned operations document (cream ground,
// navy and gold, Brandon Grotesque headlines, Plus Jakarta Sans for everything else including
// figures) designed mobile-first; tables collapse into stacked rows under 720px. Print: the
// gala booklet page frame (@media print) for the PDF. Fonts, logos, and QR codes are inlined.
import { readFileSync } from "fs";
import { join } from "path";
import { generateQRCodeSVG } from "../../server/src/routes/qr";
import type { Report, Gift, Donor } from "./data";
import { localTime } from "./data";

const THEME = join(import.meta.dir, "..", "theme");
const b64 = (file: string) => readFileSync(join(THEME, file)).toString("base64");
const wdLogo = (fill: string) => Buffer.from(readFileSync(join(THEME, "wavedepth.svg"), "utf8").replace(/fill="#1FA2BF"/g, `fill="${fill}"`)).toString("base64");
const font = (family: string, file: string, weight: number | string, style = "normal") => `@font-face{font-family:"${family}";src:url(data:font/${file.endsWith(".otf") ? "otf" : "ttf"};base64,${b64(`fonts/${file}`)});font-weight:${weight};font-style:${style};font-display:block}`;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const money0 = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pct = (v: number) => `${Math.round(v * 100)}%`;
const qr = (url: string) => generateQRCodeSVG(url, { darkColor: "#1E2A4A", lightColor: "#FFFFFF", margin: 1 }).replace("<svg ", '<svg class="qr" ');

/** The browser-side payload: enough for tables and charts, no Qgiv card data. */
function viewPayload(r: Report) {
  const gift = (g: Gift) => ({ id: g.donation_id, t: g.created_at, time: g.local_time, donor: g.donor_name, display: g.display_name, anon: g.is_anonymous, amount: g.amount_cents, method: g.payment_method, source: g.source, by: g.entered_by, status: g.status, notes: g.notes, table: g.table_number, amended: g.amended, original: g.original_amount_cents, restriction: g.qgiv?.restriction || "", recurring: !!g.qgiv?.recurring, city: g.qgiv ? [g.qgiv.city, g.qgiv.state].filter(Boolean).join(", ") : "", email: g.qgiv?.email || "", prospect: g.prospect?.name || "", sponsor: g.sponsor?.org || "", ticket: !!g.ticket, seated: g.table ? `${g.table.number}: ${g.table.host}` : "" });
  const donor = (d: Donor) => ({ key: d.key, name: d.name, display: d.display_name, anon: d.is_anonymous, total: d.total_cents, count: d.gifts.length, pledged: d.pledged_cents, paid: d.paid_cents, largest: d.largest_cents, tier: d.tier, first: d.first_gift_at, firstLabel: localTime(d.first_gift_at, r.config.timezone), rel: d.relationship, email: d.email, city: d.city, restriction: d.restriction, sources: d.sources.join("+"), by: [...new Set(d.gifts.filter(g => g.source === "manual").map(g => g.entered_by))].join(", "), prospect: d.prospect ? { name: d.prospect.name, ask: d.prospect.ask_cents, assumed: d.prospect.assumed_cents, before: d.prospect.gave_before_cents, notes: d.prospect.notes } : null, sponsor: d.sponsor ? `${d.sponsor.org} (${d.sponsor.tier})` : "", ticket: d.ticket ? `${d.ticket.tickets} ticket(s)` : "", table: d.table ? `${d.table.number}: ${d.table.host}` : "", bloomerang: d.bloomerang ? { lifetime: d.bloomerang.lifetime_cents, count: d.bloomerang.gift_count, first: d.bloomerang.first_gift.slice(0, 10), last: d.bloomerang.last_gift.slice(0, 10), lastAmount: d.bloomerang.last_gift_cents, gala: d.bloomerang.last_gala_cents, years: d.bloomerang.years_active } : null, notes: d.gifts.map(g => g.notes).filter(Boolean).join(" | ") });
  const { timeline, bands, prospects_missing, prospects_under_ask, operators, ...rest } = r.stats;
  return {
    generated_at: r.generated_at, timezone: r.config.timezone, event: r.event, stats: { ...rest, timeline, bands, operators, prospects_missing: prospects_missing.map(p => ({ name: p.name, ask: p.ask_cents, assumed: p.assumed_cents, notes: p.notes })), prospects_under_ask: prospects_under_ask.map(u => ({ name: u.donor.name, gave: u.donor.total_cents, ask: u.prospect.ask_cents })) },
    gifts: r.gifts.map(gift), donors: r.donors.map(donor), milestones: r.milestones, ask_tiers: r.ask_tiers, bloomerang: r.bloomerang,
    declined: r.qgiv.declined.map(t => ({ t: t.date_ms, time: localTime(t.date_ms, r.config.timezone), name: t.donor, email: t.email, amount: t.amount_cents, status: t.status, payment: t.payment })),
    prospects: r.prospects.map(p => { const d = r.donors.find(x => x.prospect === p); return { name: p.name, before: p.gave_before_cents, ask: p.ask_cents, assumed: p.assumed_cents, actual: d ? d.total_cents : null, matched: d?.name || "", anon: !!d?.is_anonymous, notes: p.notes }; }),
    sponsors: r.sponsors.map(sp => { const d = r.donors.find(x => x.sponsor === sp); return { org: sp.org, tier: sp.tier, cost: sp.cost_cents, poc: sp.poc, pay: sp.payment_status, gave: d ? d.total_cents : null, donor: d?.name || "" }; }),
    tables: r.tables.map(t => { const ds = r.donors.filter(d => d.table === t); return { number: t.number, host: t.host, seats: `${t.occupied}/${t.allotted}`, count: ds.reduce((n, d) => n + d.gifts.length, 0), raised: ds.reduce((n, d) => n + d.total_cents, 0), donors: ds.map(d => d.name) }; }).filter(t => t.count > 0).sort((a, b) => b.raised - a.raised),
    tickets_no_gift: r.tickets.filter(t => !t.cancelled && !r.donors.some(d => d.ticket === t)).map(t => ({ name: t.name, email: t.email, tickets: t.tickets, items: t.items })),
    takeaways: r.takeaways
  };
}

export function renderHTML(r: Report): { index: string; donors: string } {
  const s = r.stats; const c = r.config; const view = viewPayload(r);
  const generated = localTime(new Date(r.generated_at).getTime(), c.timezone, { dateStyle: "long", timeStyle: "short" });
  const eventDate = new Date(`${c.event_date}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const links = [
    { label: "Donate page", url: c.donate_url, note: "The public donation form (Qgiv). Same link the ballroom QR pointed to." },
    { label: "Givebar (sign-in only)", url: c.givebar_url, note: "Live ledger, history, stats, CSV export. Every page requires an operator account." },
    { label: "This report", url: c.share_url, note: "Password-protected. Re-published in place when the data is refreshed." },
    { label: c.client, url: c.org_url, note: "Organisation website." }
  ];
  const stat = (label: string, value: string, sub = "") => `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ""}</div>`;
  const kindLabel: Record<string, string> = { win: "Win", action: "Action", watch: "Watch", insight: "Insight" };
  const kindOrder: Record<string, number> = { action: 0, watch: 1, win: 2, insight: 3 };
  const takeaways = [...r.takeaways].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind]);
  const goalPct = Math.min(1, s.pct_of_goal);
  const sectionHead = (eyebrow: string, title: string, lead = "") => `<header class="sec-head"><p class="eyebrow">${esc(eyebrow)}</p><h2>${title}</h2>${lead ? `<p class="lead">${lead}</p>` : ""}</header>`;
  const nav = [["summary", "Summary"], ["takeaways", "Takeaways"], ["charts", "Charts"], ["donors.html", "Donors"], ["gifts", "Gifts"], ["crossref", "Cross-reference"], ["followup", "Follow-up"], ["bloomerang", "Bloomerang"], ["links", "Links"], ["method", "Method"]];

  const head = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#1E2A4A">
<title>${esc(r.event.name)} · Donor Report</title>
<style>
${font("Brandon", "Brandon_reg.otf", 400)}${font("Brandon", "Brandon_med.otf", 500)}${font("Brandon", "Brandon_bld.otf", 700)}${font("Brandon", "Brandon_blk.otf", 900)}
${font("Jakarta", "plus-jakarta-sans-400.ttf", 400)}${font("Jakarta", "plus-jakarta-sans-400-italic.ttf", 400, "italic")}${font("Jakarta", "plus-jakarta-sans-600.ttf", 600)}${font("Jakarta", "plus-jakarta-sans-700.ttf", 700)}
:root{--bg:#F4F1EA;--surface:#FFFDF9;--surface-2:#EDE8DD;--ink:#141B2E;--navy:#1E2A4A;--navy-deep:#0F1730;--slate:#3F4A63;--muted:#6E7689;--gold:#C59B27;--gold-ink:#8A5F0E;--gold-soft:#F3E6C3;--line:rgba(20,27,46,.10);--line-strong:rgba(20,27,46,.22);--red:#A8222B;--red-soft:#F8E3E4;--green:#2F6B3A;--green-soft:#E3EFE5;--orange:#B85C00;--orange-soft:#FBE9D3;
--display:"Brandon","Plus Jakarta Sans",system-ui,sans-serif;--body:"Jakarta","Plus Jakarta Sans",system-ui,sans-serif;--r:6px;--pad:clamp(16px,4vw,40px);--container:1180px;--nav-h:56px}
*{box-sizing:border-box}html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
a{color:var(--navy);text-decoration-color:rgba(30,42,74,.35);text-underline-offset:2px}a:hover{text-decoration-color:var(--gold)}
h1,h2,h3{font-family:var(--display);color:var(--navy);margin:0;line-height:1;letter-spacing:.005em}
h1{font-size:clamp(34px,6vw,64px);font-weight:900;text-transform:uppercase;color:#fff;max-width:14ch}
h2{font-size:clamp(26px,3.6vw,40px);font-weight:900;text-transform:uppercase}h2 em{font-style:normal;color:var(--gold)}
h3{font-size:clamp(17px,2vw,20px);font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin:40px 0 14px;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}h3 small{font-family:var(--body);font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)}
.eyebrow{font-family:var(--display);font-weight:700;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--gold-ink);margin:0 0 12px}
.lead{font-size:clamp(15px,1.6vw,17px);color:var(--slate);max-width:62ch;margin:16px 0 0}
.wrap{max-width:var(--container);margin:0 auto;padding:0 var(--pad)}
.sec{padding:clamp(48px,7vw,88px) 0;border-top:1px solid var(--line)}.sec:first-of-type{border-top:0}
.sec-head{max-width:72ch}
/* top bar */
.top{position:sticky;top:0;z-index:20;background:rgba(244,241,234,.92);backdrop-filter:saturate(1.2) blur(10px);-webkit-backdrop-filter:saturate(1.2) blur(10px);border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;gap:20px;height:var(--nav-h)}
.brand{display:flex;align-items:center;gap:10px;font-family:var(--display);font-weight:700;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--navy);white-space:nowrap;text-decoration:none}.brand img{height:26px;width:auto}
.topnav{display:flex;gap:2px;margin-left:auto;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}.topnav::-webkit-scrollbar{display:none}
.topnav a{font-family:var(--display);font-weight:700;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--slate);text-decoration:none;padding:8px 10px;border-radius:var(--r);white-space:nowrap}.topnav a:hover{color:var(--navy);background:var(--surface-2)}.topnav a.on{color:var(--navy);box-shadow:inset 0 -2px 0 var(--gold)}
.top .dl{display:flex;gap:8px}.btn .abbr{display:none}
.btn{font-family:var(--display);font-weight:700;font-size:12px;letter-spacing:.12em;text-transform:uppercase;text-decoration:none;display:inline-flex;align-items:center;gap:8px;min-height:40px;padding:0 14px;border-radius:var(--r);border:1px solid var(--navy);background:var(--navy);color:#fff;cursor:pointer;white-space:nowrap}.btn:hover{background:var(--navy-deep)}.btn.ghost{background:transparent;color:var(--navy)}.btn.ghost:hover{background:var(--surface-2)}.btn.light{background:#fff;border-color:#fff;color:var(--navy)}.btn.light.ghost{background:transparent;color:#fff;border-color:rgba(255,255,255,.45)}.btn.light.ghost:hover{background:rgba(255,255,255,.08)}
@media (max-width:860px){.top .wrap{flex-wrap:wrap;height:auto;padding-top:10px;padding-bottom:0;gap:8px 12px}.top .dl{margin-left:auto}.topnav{order:3;flex-basis:100%;margin:0 calc(-1*var(--pad));padding:0 var(--pad) 6px}.top .dl .btn{min-height:34px;padding:0 10px;font-size:11px}.btn .full{display:none}.btn .abbr{display:inline}.brand{font-size:12px}}
/* hero */
.hero{background:linear-gradient(170deg,#0F1730 0%,#1A2545 60%,#1E2A4A 100%);color:#fff;padding:clamp(40px,7vw,96px) 0 0}
.hero .eyebrow{color:#E5C578}
.hero-grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:clamp(28px,5vw,72px);align-items:end}
.hero .sub{margin:18px 0 0;font-size:clamp(15px,1.8vw,18px);color:#C9D3E8;max-width:52ch}
.total-label{font-family:var(--display);font-weight:700;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#E5C578}
.total{font-family:var(--display);font-weight:900;font-size:clamp(52px,9vw,104px);line-height:.95;letter-spacing:-.01em;color:#FDE6B0;margin:6px 0 10px}
.goal{margin-top:22px}.goal-bar{position:relative;height:6px;background:rgba(255,255,255,.14);border-radius:3px;overflow:visible}.goal-bar i{position:absolute;left:0;top:0;bottom:0;width:${(goalPct * 100).toFixed(1)}%;background:linear-gradient(90deg,#C59B27,#FDE6B0);border-radius:3px}
.goal-bar b{position:absolute;top:-5px;width:2px;height:16px;background:rgba(255,255,255,.45);transform:translateX(-1px)}.goal-bar b.hit{background:#FDE6B0}
.goal-meta{display:flex;justify-content:space-between;gap:12px;font-size:13px;color:#C9D3E8;margin-top:10px}.goal-meta strong{color:#fff;font-weight:600}
.hero-stats{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.12);border-radius:var(--r);overflow:hidden}
.hero-stats .stat{background:rgba(15,23,48,.55);padding:16px 18px}.hero-stats .stat-label{color:#9FB0D4}.hero-stats .stat-value{color:#fff;font-size:clamp(22px,2.6vw,30px)}.hero-stats .stat-sub{color:#9FB0D4}
.hero-foot{margin-top:clamp(28px,5vw,56px);border-top:1px solid rgba(229,197,120,.35);padding:16px 0 20px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;font-size:13px;color:#9FB0D4}
.hero-foot .prepared{display:flex;align-items:center;gap:10px;color:#C9D3E8}.hero-foot img{height:20px;width:auto}
@media (max-width:860px){.hero-grid{grid-template-columns:1fr}.hero-stats{grid-template-columns:1fr 1fr}}
/* stats */
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px 28px;margin-top:32px}
.stat{border-top:2px solid var(--navy);padding-top:12px;min-width:0}.stat.gold{border-top-color:var(--gold)}
.stat-label{font-family:var(--display);font-weight:700;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--slate)}
.stat-value{font-size:clamp(24px,3vw,32px);font-weight:700;line-height:1.1;margin-top:6px;letter-spacing:-.01em;color:var(--ink)}
.stat-sub{font-size:13px;color:var(--muted);margin-top:4px}
@media (max-width:900px){.stats{grid-template-columns:repeat(3,minmax(0,1fr))}}@media (max-width:600px){.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 16px}}
.two{display:grid;grid-template-columns:1fr 1fr;gap:clamp(24px,4vw,56px);align-items:start}@media (max-width:860px){.two{grid-template-columns:1fr}}
/* takeaways */
.take{list-style:none;margin:32px 0 0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:14px}
.take li{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px 18px 22px;position:relative;min-width:0}
.take li::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;border-radius:var(--r) 0 0 var(--r);background:var(--gold)}
.take li.action::before{background:var(--orange)}.take li.win::before{background:var(--green)}.take li.watch::before{background:var(--red)}
.take .tag{display:inline-block;font-family:var(--display);font-weight:700;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold-ink);margin-bottom:8px}.take li.action .tag{color:var(--orange)}.take li.win .tag{color:var(--green)}.take li.watch .tag{color:var(--red)}
.take h4{font-family:var(--body);font-weight:700;font-size:16px;line-height:1.3;margin:0 0 6px;color:var(--navy);text-wrap:balance}.take p{margin:0;font-size:14px;color:var(--slate)}
@media (max-width:860px){.take{grid-template-columns:1fr}}
/* charts */
.chart-box{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:clamp(12px,2vw,20px);margin-top:14px;min-width:0;overflow:hidden}
.chart{width:100%;height:auto;display:block}.chart text{font-family:var(--body);font-size:11px;fill:var(--slate)}.chart .axis{stroke:var(--line)}.chart .bar{fill:var(--navy)}.chart .bar.gold{fill:var(--gold)}.chart .line{fill:none;stroke:var(--gold-ink);stroke-width:2}.chart .area{fill:url(#goldfade)}.chart .lbl{font-family:var(--display);font-weight:700;font-size:11px;letter-spacing:.08em;fill:var(--navy)}
.legend{display:flex;gap:8px 18px;flex-wrap:wrap;font-size:13px;color:var(--slate);margin-top:12px}.legend i{display:inline-block;width:10px;height:10px;margin-right:6px;border-radius:2px;vertical-align:-1px}
/* toolbar */
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:28px 0 14px;position:sticky;top:var(--nav-h);z-index:5;background:var(--bg);padding:10px 0}
.toolbar input[type=search],.toolbar select{font:inherit;font-size:15px;min-height:42px;padding:0 12px;border:1px solid var(--line-strong);background:var(--surface);border-radius:var(--r);color:var(--ink)}.toolbar input[type=search]{flex:1 1 240px;min-width:0}.toolbar select{flex:0 1 auto;max-width:100%}
.toolbar input:focus-visible,.toolbar select:focus-visible,.btn:focus-visible,.chip:focus-within{outline:2px solid var(--gold);outline-offset:2px}
.chip{display:inline-flex;align-items:center;gap:8px;min-height:42px;padding:0 12px;border:1px solid var(--line-strong);border-radius:var(--r);background:var(--surface);font-size:13px;color:var(--slate);cursor:pointer;user-select:none}.chip input{margin:0;accent-color:var(--navy);width:16px;height:16px}.chip:has(input:checked){background:var(--navy);border-color:var(--navy);color:#fff}
.toolbar .count{margin-left:auto;font-size:13px;color:var(--muted);white-space:nowrap}
@media (max-width:860px){.toolbar{top:0;position:static}.toolbar .count{margin-left:0;flex-basis:100%}}
/* tables */
.tbl{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:14px}
th{font-family:var(--display);font-weight:700;font-size:11px;letter-spacing:.12em;text-transform:uppercase;text-align:left;color:var(--slate);padding:12px 14px;border-bottom:1px solid var(--line-strong);white-space:nowrap;background:var(--surface-2);user-select:none}th[data-k]{cursor:pointer}th[data-k]:hover{color:var(--navy)}th.r,td.r{text-align:right}th[data-dir]{color:var(--navy)}th[data-dir]::after{content:" ↓";color:var(--gold-ink)}th[data-dir="asc"]::after{content:" ↑"}
td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}tbody tr:last-child td{border-bottom:0}tbody tr:hover td{background:rgba(197,155,39,.06)}
td.name{font-weight:600;color:var(--navy)}td.nowrap{white-space:nowrap}td.dim,.dim{color:var(--muted)}td .sub{display:block;font-weight:400;font-size:12.5px;color:var(--muted);margin-top:2px}td b{font-weight:700}
.pill{display:inline-block;font-family:var(--display);font-weight:700;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;padding:3px 7px;border-radius:4px;background:var(--surface-2);color:var(--slate);margin:0 4px 4px 0;white-space:nowrap;vertical-align:middle}.pill.gold{background:var(--gold-soft);color:var(--gold-ink)}.pill.navy{background:var(--navy);color:#fff}.pill.red{background:var(--red-soft);color:var(--red)}.pill.green{background:var(--green-soft);color:var(--green)}.pill.orange{background:var(--orange-soft);color:var(--orange)}
.more{display:flex;justify-content:center;padding:14px;border-top:1px solid var(--line);background:var(--surface)}.more:empty{display:none}
@media (max-width:720px){
  .tbl table,.tbl tbody,.tbl tr,.tbl td{display:block}.tbl thead{display:none}
  .tbl tr{padding:12px 14px;border-bottom:1px solid var(--line)}.tbl tr:last-child{border-bottom:0}
  .tbl td{padding:3px 0;border:0;text-align:left!important}.tbl td:empty{display:none}
  .tbl td[data-l]::before{content:attr(data-l);display:inline-block;min-width:96px;font-family:var(--display);font-weight:700;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-right:8px}
  .tbl td.name{font-size:16px;padding-bottom:6px}.tbl td.name::before{display:none}.tbl td.amt{font-size:18px;font-weight:700;padding-bottom:6px}.tbl td.amt::before{display:none}
  .tbl tbody tr:hover td{background:none}
}
/* misc blocks */
.note{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;font-size:14px;color:var(--slate)}.note.warn{border-color:#E9C58A;background:#FBF3E4}.note code{font-family:var(--body);font-weight:600;color:var(--navy);word-break:break-all}
.links{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-top:32px}.link{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:18px;text-align:center;min-width:0}.link .qr{width:min(160px,100%);height:auto;display:block;margin:0 auto 12px}.link b{display:block;font-family:var(--display);text-transform:uppercase;letter-spacing:.1em;font-size:12px;color:var(--navy)}.link a{font-size:13px;word-break:break-all}.link p{font-size:13px;color:var(--muted);margin:8px 0 0}
@media (max-width:900px){.links{grid-template-columns:1fr 1fr}}@media (max-width:480px){.links{grid-template-columns:1fr}}
dl.spec{display:grid;grid-template-columns:200px 1fr;gap:10px 20px;font-size:14px;margin:32px 0 0}dl.spec dt{font-weight:700;color:var(--navy)}dl.spec dd{margin:0;color:var(--slate)}@media (max-width:640px){dl.spec{grid-template-columns:1fr;gap:2px}dl.spec dd{margin-bottom:12px}}
.foot{border-top:1px solid var(--line);margin-top:56px;padding:24px 0 max(24px,env(safe-area-inset-bottom));display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--muted)}.foot img{height:18px;vertical-align:middle}
.print-only{display:none}
@media print{
  @page{size:letter;margin:.45in}
  body{background:#fff;font-size:11.5px}.top,.toolbar,.hide-print,.more{display:none!important}.print-only{display:inline-flex}
  .wrap{max-width:none;padding:0}.sec{padding:0;border:0;break-after:page;page-break-after:always;position:relative;min-height:9.6in;padding:22px 26px}.sec::before{content:"";position:absolute;inset:6px;border:1px solid var(--gold);pointer-events:none}
  .hero{padding:40px 36px;min-height:9.6in;break-after:page;-webkit-print-color-adjust:exact;print-color-adjust:exact}.hero-grid{grid-template-columns:1fr}
  h2{font-size:24px}.stats{grid-template-columns:repeat(4,1fr);gap:14px}.stat-value{font-size:20px}.take{grid-template-columns:1fr 1fr}.two{display:block}.two>div{margin-bottom:18px}
  .tbl{border:0}table{font-size:10.5px}td,th{padding:4px 6px}tr{break-inside:avoid}.print-limit tbody tr:nth-child(n+41){display:none}.print-limit::after{content:"Showing the first 40 rows; the full list is in the workbook and the interactive report.";display:block;font-size:10px;color:var(--muted);margin-top:6px}
  .stat,.take li,.pill,.chart .bar,.link,.chart-box{-webkit-print-color-adjust:exact;print-color-adjust:exact}#chart-timeline svg{height:2.7in}#chart-bands svg{height:2.4in}#chart-mix svg{height:1.9in}#chart-pareto svg{height:1.7in}h3{break-after:avoid}
}
</style></head>
<body>
`;
  const topbar = (page: string) => `<header class="top hide-print"><div class="wrap">
  <a class="brand" href="index.html#top"><img alt="" src="data:image/png;base64,${b64("cair-georgia-logo.png")}">Donor Report</a>
  <nav class="topnav" aria-label="Sections">${nav.map(([id, label]) => `<a href="${id.endsWith(".html") ? id : `${page}#${id}`}"${id.endsWith(".html") && page === id ? ' class="on"' : ""}>${label}</a>`).join("")}</nav>
  <div class="dl"><a class="btn ghost" href="${esc(c.output_basename)}.xlsx" download><span class="full">Workbook</span><span class="abbr">XLSX</span></a><a class="btn ghost" href="${esc(c.output_basename)}.pdf" download>PDF</a></div>
</div></header>`;
  const body = `
<section class="hero" id="top"><div class="wrap">
  <div class="hero-grid">
    <div>
      <p class="eyebrow">${esc(c.client)} · ${esc(eventDate)}</p>
      <h1>${esc(c.event_short)} Donor Report</h1>
      <p class="sub">${esc(r.event.subtitle.replace(/[.\s]+$/, ""))}. Every gift, every pledge, and what to do about them this week.</p>
      <div class="goal">
        <div class="total-label">Raised on the night</div>
        <div class="total">${esc(money0(s.total_cents))}</div>
        <div class="goal-bar"><i></i>${r.milestones.map(m => `<b class="${m.reached_at ? "hit" : ""}" style="left:${Math.min(100, (m.cents / (s.goal_cents || 1)) * 100).toFixed(1)}%" title="${esc(m.label)}"></b>`).join("")}</div>
        <div class="goal-meta"><span><strong>${esc(pct(s.pct_of_goal))}</strong> of the ${esc(money0(s.goal_cents))} goal</span><span>${esc(money0(Math.max(0, s.goal_cents - s.total_cents)))} to go</span></div>
      </div>
    </div>
    <div class="hero-stats">
      ${stat("Gifts", String(s.active_count), `${s.households} households`)}
      ${stat("Pledges to collect", money0(s.pledge_cents), `${s.pledge_count} pledges`)}
      ${stat("Online, settled", money0(s.online_cents), `${s.online_count} card gifts`)}
      ${stat("Major gifts", String(s.major_count), `${money0(s.major_cents)} at ${money0(r.event.major_gift_threshold_cents)}+`)}
    </div>
  </div>
  <div class="hero-foot">
    <span class="prepared">Prepared by <img alt="wavedepth" src="data:image/svg+xml;base64,${wdLogo("#FFFFFF")}"></span>
    <span>Internal to the ${esc(c.client)} team. Contains donor names, pledges, and staff notes. Generated ${esc(generated)}.</span>
  </div>
</div></section>

<main>
<section class="sec" id="summary"><div class="wrap">
  ${sectionHead("Summary", "The night <em>in numbers</em>", `Every figure comes from the Givebar ledger (an append-only record of every gift, correction, and deletion), the Qgiv online form behind the QR code, and the staff MASTER workbook. Times are ${esc(c.timezone.replace("_", " "))}.`)}
  <div class="stats">
    ${stat("Total raised", money0(s.total_cents), `${pct(s.pct_of_goal)} of ${money0(s.goal_cents)}`)}
    ${stat("Gifts", String(s.active_count), `${s.households} households · ${s.void_count} deleted`)}
    ${stat("Ballroom pledges", money0(s.pledge_cents), `${s.pledge_count} pledges, not yet cash`)}
    ${stat("Online, settled", money0(s.online_cents), `net ${money0(s.net_online_cents)} after fees`)}
    ${stat("Average gift", money0(s.avg_cents), `median ${money0(s.median_cents)}`)}
    ${stat("Major gifts", money0(s.major_cents), `${s.major_count} at ${money0(r.event.major_gift_threshold_cents)}+`)}
    ${stat("Top 10 gifts", pct(s.top10_pct), `${money0(s.top10_cents)} of the total`)}
    ${stat("Anonymous", money0(s.anonymous_cents), `${s.anonymous_count} gifts`)}
    ${stat("Zakat, online", money0(s.zakat_cents), `${s.zakat_count} gifts · ${pct(s.zakat_cents / (s.online_cents || 1))} of online`)}
    ${stat("Monthly donors", String(s.recurring_count), `${money0(s.recurring_monthly_cents)} per month started`)}
    ${stat("Fees covered by donors", money0(s.gift_assist_cents), `of ${money0(s.fees_cents)} charged`)}
    ${stat("Declined online", String(s.declined_count), `${money0(s.declined_cents)} attempted`)}
  </div>
  <div class="two" style="margin-top:8px">
    <div><h3>Milestones</h3><div class="tbl"><table><thead><tr><th>Level</th><th class="r">Amount</th><th>Reached</th></tr></thead><tbody>${r.milestones.map(m => `<tr><td class="name">${esc(m.label)}</td><td class="r" data-l="Amount">${esc(money0(m.cents))}</td><td data-l="Reached">${m.reached_at ? esc(localTime(m.reached_at, c.timezone, { hour: "numeric", minute: "2-digit" })) : '<span class="pill">not reached</span>'}</td></tr>`).join("")}</tbody></table></div></div>
    <div><h3>Quick amounts <small>gifts at exactly the tier</small></h3><div class="tbl"><table><thead><tr><th>Tier</th><th class="r">Gifts</th></tr></thead><tbody>${r.ask_tiers.map(t => `<tr><td class="name">${esc(t.label)}</td><td class="r" data-l="Gifts">${t.hits}</td></tr>`).join("")}</tbody></table></div>
    <h3>Who recorded</h3><div class="tbl"><table><thead><tr><th>Source</th><th class="r">Gifts</th><th class="r">Amount</th></tr></thead><tbody>${s.operators.map(o => `<tr><td class="name">${esc(o.name)}</td><td class="r" data-l="Gifts">${o.count}</td><td class="r" data-l="Amount">${esc(money0(o.cents))}</td></tr>`).join("")}</tbody></table></div></div>
  </div>
</div></section>

<section class="sec" id="takeaways"><div class="wrap">
  ${sectionHead("Takeaways", "What to do <em>this week</em>", "Generated from the numbers. Actions first, then things to watch, then context. Each one names the list to work from in the workbook.")}
  <ol class="take">${takeaways.map(t => `<li class="${t.kind}"><span class="tag">${esc(kindLabel[t.kind])}</span><h4>${esc(t.title)}</h4>${t.body ? `<p>${esc(t.body)}</p>` : ""}</li>`).join("")}</ol>
</div></section>

<section class="sec" id="charts"><div class="wrap">
  ${sectionHead("Charts", "How the night <em>unfolded</em>")}
  <h3>Running total and gifts per 15 minutes</h3>
  <div class="chart-box"><div id="chart-timeline"></div>
  <div class="legend"><span><i style="background:var(--navy)"></i>Gifts in window</span><span><i style="background:var(--gold-ink)"></i>Running total</span>${s.peak ? `<span>Peak: <b>${esc(s.peak.label)}</b>, ${esc(money0(s.peak.cents))} across ${s.peak.count} gifts</span>` : ""}</div></div>
  <div class="two">
    <div><h3>Gift size bands</h3><div class="chart-box"><div id="chart-bands"></div></div></div>
    <div><h3>Where the money came from</h3><div class="chart-box"><div id="chart-mix"></div></div>
      <h3>Concentration</h3><div class="chart-box"><div id="chart-pareto"></div></div></div>
  </div>
</div></section>

<section class="sec" id="donors"><div class="wrap">
  ${sectionHead("Donors", "Every donor <em>household</em>", `${s.households} households with search, filters, sort, and CSV export live on their own page so this document stays readable.`)}
  <p style="margin:24px 0 0;display:flex;gap:12px;flex-wrap:wrap;align-items:center"><a class="btn hide-print" href="donors.html">Open the donor list</a><a class="btn print-only" href="${esc(c.share_url)}donors.html">Open the donor list</a><span class="dim" style="font-size:13px">${esc(c.share_url)}donors.html · same password</span></p>
</div></section>

<section class="sec" id="gifts"><div class="wrap">
  ${sectionHead("Gifts", "Every gift, <em>in order</em>", `${r.gifts.length} ledger entries including ${s.void_count} deleted and ${s.amended_count} corrected. The workbook carries the full event log with every amendment.`)}
  <div class="toolbar"><input type="search" id="gift-q" placeholder="Search gifts" aria-label="Search gifts"><select id="gift-f" aria-label="Filter gifts"><option value="">All entries</option><option value="active">Active only</option><option value="voided">Deleted only</option><option value="pledge">Pledges</option><option value="online">Online</option><option value="amended">Corrected</option><option value="anon">Anonymous</option><option value="notes">With team note</option></select><label class="chip"><input type="checkbox" id="gift-legal">Legal names</label><button class="btn ghost" id="gift-csv" type="button">CSV of this view</button><span class="count" id="gift-count"></span></div>
  <div class="tbl print-limit"><table id="gift-table"><thead><tr><th data-k="t">Time</th><th data-k="donor">Donor</th><th data-k="amount" class="r">Amount</th><th data-k="method">Method</th><th data-k="source">Source</th><th data-k="by">Recorded by</th><th>Flags</th><th>Note</th></tr></thead><tbody></tbody></table><div class="more" id="gift-more"></div></div>
</div></section>

<section class="sec" id="crossref"><div class="wrap">
  ${sectionHead("Cross-reference", "Prospects, sponsors, <em>tables</em>", "Tonight's ledger against the staff MASTER workbook: the major-donor ask list, sponsorship packages, seating, and ticket orders. Matching is by name and email; a blank means no automatic match, not necessarily no gift.")}
  <div class="stats" style="grid-template-columns:repeat(4,minmax(0,1fr))">${stat("Prospects on list", String(s.prospects_total))}${stat("Gave tonight", String(s.prospects_gave), `${money0(s.prospects_actual_cents)} recorded`)}${stat("Asks on the list", money0(s.prospects_ask_cents))}${stat("Below ask", String(s.prospects_under_ask.length), `${s.prospects_missing.length} with an ask and no gift`)}</div>
  <h3>Major-donor ask list vs. actual</h3>
  <div class="tbl print-limit"><table id="prospect-table"><thead><tr><th data-k="name">Prospect</th><th data-k="before" class="r">Gave earlier 2026</th><th data-k="ask" class="r">Ask</th><th data-k="assumed" class="r">Assumed</th><th data-k="actual" class="r">Gave tonight</th><th data-k="delta" class="r">vs. ask</th><th>Status</th><th>Notes</th></tr></thead><tbody></tbody></table></div>
  <div class="two">
    <div><h3>Tables that gave</h3><div class="tbl print-limit"><table id="table-table"><thead><tr><th>Table</th><th>Host</th><th class="r">Gifts</th><th class="r">Raised</th></tr></thead><tbody></tbody></table></div></div>
    <div><h3>Sponsors with an appeal gift</h3><div class="tbl print-limit"><table id="sponsor-table"><thead><tr><th>Sponsor</th><th>Tier</th><th class="r">Package</th><th class="r">Appeal gift</th></tr></thead><tbody></tbody></table></div></div>
  </div>
</div></section>

<section class="sec" id="followup"><div class="wrap">
  ${sectionHead("Follow-up", "Lists to <em>work from</em>")}
  <div class="two">
    <div><h3>Pledges to collect <small>${esc(money0(s.pledge_cents))}</small></h3><div class="tbl print-limit"><table id="pledge-table"><thead><tr><th>Donor</th><th class="r">Pledged</th><th>Recorded by</th><th>Table</th></tr></thead><tbody></tbody></table></div></div>
    <div><h3>Prospects with an ask and no gift</h3><div class="tbl print-limit"><table id="missing-table"><thead><tr><th>Prospect</th><th class="r">Ask</th><th>Notes</th></tr></thead><tbody></tbody></table></div>
      <h3>Declined online attempts</h3><div class="tbl"><table id="declined-table"><thead><tr><th>Time</th><th>Name</th><th class="r">Amount</th><th>Payment</th></tr></thead><tbody></tbody></table></div></div>
  </div>
  <h3>Ticket buyers with no gift recorded <small>${view.tickets_no_gift.length} people</small></h3>
  <div class="tbl print-limit"><table id="ticket-table"><thead><tr><th>Name</th><th>Email</th><th class="r">Tickets</th><th>Order</th></tr></thead><tbody></tbody></table><div class="more" id="ticket-more"></div></div>
</div></section>

<section class="sec" id="bloomerang"><div class="wrap">
  ${sectionHead("Bloomerang", "Giving <em>history</em>")}
  ${r.bloomerang.connected
    ? `<p class="lead">${r.bloomerang.matched} of ${s.households} households matched a Bloomerang constituent (${r.bloomerang.constituents} constituents pulled ${esc(r.bloomerang.pulled_at.slice(0, 10))}). ${s.repeat_donors} repeat donors, ${s.new_donors} first-time donors.</p>
       <div class="tbl print-limit" style="margin-top:24px"><table id="bloom-table"><thead><tr><th>Donor</th><th class="r">Tonight</th><th class="r">Lifetime</th><th class="r">Gifts</th><th>First gift</th><th>Last gift</th><th class="r">Last gala</th><th>Years</th></tr></thead><tbody></tbody></table></div>`
    : `<div class="note warn" style="margin-top:24px;max-width:72ch"><b>Not connected yet.</b> ${esc(r.bloomerang.message)}<br><br>What it adds to every donor row: repeat or first-time, first gift date, last gift date and amount, lifetime total, years active, and the gift made at last year's gala (${esc(c.previous_event_date)}). The columns already exist in the workbook and in the donor table above; they fill in on the next build.</div>`}
</div></section>

<section class="sec" id="links"><div class="wrap">
  ${sectionHead("Links", "Links and <em>QR codes</em>")}
  <div class="links">${links.map(l => `<div class="link">${qr(l.url)}<b>${esc(l.label)}</b><a href="${esc(l.url)}">${esc(l.url.replace(/^https?:\/\//, ""))}</a><p>${esc(l.note)}</p></div>`).join("")}</div>
  <h3>Ballroom QR target</h3>
  <p class="note">The projector QR pointed to <code>${esc(r.event.qr_url)}</code> (printed as <b>${esc(r.event.display_url)}</b>). Its UTM tags let the website analytics separate ballroom scans from email and social traffic.</p>
</div></section>

<section class="sec" id="method"><div class="wrap">
  ${sectionHead("Method", "Sources and <em>definitions</em>")}
  <dl class="spec">
    <dt>Givebar ledger</dt><dd>VACUUM INTO snapshot of the production database taken ${esc(generated)}. Totals are the deterministic fold of every create, amend, void, and restore event. Rehearsal gifts are excluded.</dd>
    <dt>Online gifts</dt><dd>Qgiv form "${esc(r.qgiv.form_name)}" (${r.qgiv.all.length} transactions since January 1, pulled ${esc(r.qgiv.pulled_at.slice(0, 16).replace("T", " "))} UTC). Gift time is the Qgiv transaction time, not the import time. Amount is the gift net of donor-covered fees; fee and net columns are in the workbook.</dd>
    <dt>Pledges</dt><dd>Gifts recorded by staff in the ballroom with the Pledge method. They are commitments, not cash, until collected.</dd>
    <dt>Households</dt><dd>Gifts are grouped by first and last name after removing titles ("Dr.", "Household of") and splitting couples. Anonymous gifts with no legal name stay separate.</dd>
    <dt>Cross-reference</dt><dd>MASTER workbook sheets ${esc(Object.values(c.master_sheets).join(", "))}, matched by person name and, for online gifts, email. Automatic matching is conservative: verify before acting on a blank.</dd>
    <dt>Bloomerang</dt><dd>${r.bloomerang.connected ? `Constituents and transactions via the REST API; "last gala" is any gift within two weeks before to three weeks after ${esc(c.previous_event_date)} or tagged to a campaign or appeal named Gala.` : "Not connected; see the Bloomerang section."}</dd>
    <dt>Privacy</dt><dd>This report includes legal names of anonymous donors (hidden by default in the donor table), staff names, and team notes. It is for the ${esc(c.client)} team only. The public chart never showed any of these.</dd>
    <dt>Refreshing</dt><dd>Run <code>bun reports/build-report.ts</code> after <code>reports/pull-givebar.sh</code> (and the Qgiv/Bloomerang pulls). Outputs are rebuilt in place and re-published to the same password-protected link.</dd>
  </dl>
  <div class="foot"><span>${esc(r.event.name)} · Donor Report · generated ${esc(generated)}</span><span>Prepared by <img alt="wavedepth" src="data:image/svg+xml;base64,${wdLogo("#1E2A4A")}"></span></div>
</div></section>
</main>`;
  const donorsBody = `<main>
<section class="sec" id="donors" style="border-top:0;padding-top:clamp(28px,4vw,48px)"><div class="wrap">
  ${sectionHead("Donors", "Every donor <em>household</em>", `${s.households} households, largest first. Gifts from the same person across the ballroom form and the online form are combined. Search by name, email, city, table, or note. <a href="index.html">Back to the report</a>.`)}
  <div class="toolbar"><input type="search" id="donor-q" placeholder="Search donors" aria-label="Search donors"><select id="donor-f" aria-label="Filter donors"><option value="">All donors</option><option value="pledge">Has pledge to collect</option><option value="online">Gave online</option><option value="anon">Anonymous</option><option value="prospect">On prospect list</option><option value="sponsor">Sponsor</option><option value="ticket">Ticket buyer</option><option value="repeat">Repeat (Bloomerang)</option><option value="new">First-time (Bloomerang)</option><option value="major">Major gift</option></select><label class="chip"><input type="checkbox" id="donor-legal">Legal names</label><label class="chip"><input type="checkbox" id="donor-notes">Team notes</label><button class="btn ghost" id="donor-csv" type="button">CSV of this view</button><span class="count" id="donor-count"></span></div>
  <div class="tbl print-limit"><table id="donor-table"><thead><tr><th data-k="name">Donor</th><th data-k="total" class="r">Total</th><th data-k="count" class="r">Gifts</th><th data-k="pledged" class="r">Pledged</th><th data-k="paid" class="r">Online</th><th data-k="first">First gift</th><th>Context</th><th data-k="rel">History</th></tr></thead><tbody></tbody></table><div class="more" id="donor-more"></div></div>
</div></section>
</main>`;
  const script = `<script id="report-data" type="application/json">${JSON.stringify(view).replace(/</g, "\\u003c")}</script>
<script>
(function(){
const R=JSON.parse(document.getElementById('report-data').textContent);
const $=s=>document.querySelector(s);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=c=>(c/100).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:c%100?2:0});const usd0=c=>(c/100).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
const pill=(t,k)=>'<span class="pill '+(k||'')+'">'+esc(t)+'</span>';const td=(l,body,cls)=>'<td data-l="'+esc(l)+'"'+(cls?' class="'+cls+'"':'')+'>'+body+'</td>';
const PAGE=60;
function csv(rows,name){const lines=rows.map(r=>r.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(','));const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([lines.join('\\n')],{type:'text/csv'}));a.download=name;a.click();}
function sortable(table,state,render){table.querySelectorAll('th[data-k]').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.k;state.dir=state.key===k&&state.dir==='desc'?'asc':'desc';state.key=k;state.limit=PAGE;table.querySelectorAll('th').forEach(h=>h.removeAttribute('data-dir'));th.dataset.dir=state.dir;render();}));}
function sortRows(rows,state){const k=state.key;if(!k)return rows;const m=state.dir==='asc'?1:-1;return rows.slice().sort((a,b)=>{const x=a[k],y=b[k];if(typeof x==='number'&&typeof y==='number')return (x-y)*m;return String(x??'').localeCompare(String(y??''))*m;});}
function paged(rows,state,moreEl,render){const shown=rows.slice(0,state.limit||PAGE);moreEl.innerHTML=rows.length>shown.length?'<button class="btn ghost" type="button">Show '+Math.min(PAGE,rows.length-shown.length)+' more of '+(rows.length-shown.length)+'</button>':'';const b=moreEl.querySelector('button');if(b)b.addEventListener('click',()=>{state.limit=(state.limit||PAGE)+PAGE;render();});return shown;}

if(document.getElementById('donor-table')){
const dState={key:'total',dir:'desc',limit:PAGE};let dView=[];
function donorName(d,legal){const shown=d.anon&&!legal?d.display:d.name;return '<td class="name">'+esc(shown)+(d.anon?' '+pill('anon','gold'):'')+(!d.anon&&d.display!==d.name?'<span class="sub">shown as '+esc(d.display)+'</span>':'')+'</td>';}
function renderDonors(){const q=$('#donor-q').value.trim().toLowerCase();const f=$('#donor-f').value;const legal=$('#donor-legal').checked;const notes=$('#donor-notes').checked;
 dView=R.donors.filter(d=>{if(f==='pledge'&&!d.pledged)return false;if(f==='online'&&!d.paid)return false;if(f==='anon'&&!d.anon)return false;if(f==='prospect'&&!d.prospect)return false;if(f==='sponsor'&&!d.sponsor)return false;if(f==='ticket'&&!d.ticket)return false;if(f==='repeat'&&d.rel!=='repeat')return false;if(f==='new'&&d.rel!=='new')return false;if(f==='major'&&d.largest<R.event.major_gift_threshold_cents)return false;
  if(!q)return true;const hay=[legal||!d.anon?d.name:'',d.display,d.email,d.city,d.table,d.sponsor,d.prospect&&d.prospect.name,notes?d.notes:''].join(' ').toLowerCase();return hay.includes(q);});
 const rows=sortRows(dView,dState);$('#donor-count').textContent=rows.length+' of '+R.donors.length+' households · '+usd0(rows.reduce((s,d)=>s+d.total,0));
 const shown=paged(rows,dState,$('#donor-more'),renderDonors);
 $('#donor-table tbody').innerHTML=shown.map(d=>{const ctx=[];const ident=legal||!d.anon;if(ident&&d.prospect)ctx.push(pill('ask '+usd0(d.prospect.ask||0),'navy'));if(ident&&d.sponsor)ctx.push(pill('sponsor','gold'));if(ident&&d.ticket)ctx.push(pill('ticket'));if(ident&&d.table)ctx.push(pill('table '+d.table.split(':')[0]));if(d.restriction)ctx.push(pill(d.restriction,'green'));if(d.sources.includes('online')&&d.city)ctx.push(pill(d.city));if(d.largest>=R.event.major_gift_threshold_cents)ctx.push(pill('major','orange'));
  const hist=d.bloomerang?('<b>'+usd0(d.bloomerang.lifetime)+'</b> lifetime · '+d.bloomerang.count+' gifts<span class="sub">last '+esc(d.bloomerang.last)+' '+usd0(d.bloomerang.lastAmount)+(d.bloomerang.gala?' · gala '+usd0(d.bloomerang.gala):'')+'</span>'):(d.rel==='repeat'?pill('repeat','green'):(d.prospect&&d.prospect.before?'<span class="dim">gave '+usd0(d.prospect.before)+' earlier in 2026</span>':''));
  return '<tr>'+donorName(d,legal)+td('Total','<b>'+usd(d.total)+'</b>','r amt')+td('Gifts',d.count,'r')+td('Pledged',d.pledged?usd(d.pledged):'','r')+td('Online',d.paid?usd(d.paid):'','r')+td('First gift',esc(d.firstLabel),'dim nowrap')+td('Context',ctx.join('')+(notes&&d.notes?'<span class="sub">'+esc(d.notes)+'</span>':''))+td('History',hist)+'</tr>';}).join('');}
['#donor-q','#donor-f','#donor-legal','#donor-notes'].forEach(s=>$(s).addEventListener('input',()=>{dState.limit=PAGE;renderDonors();}));sortable($('#donor-table'),dState,renderDonors);renderDonors();
$('#donor-csv').addEventListener('click',()=>{const legal=$('#donor-legal').checked;csv([['Donor','Display name','Anonymous','Total','Gifts','Pledged','Online','First gift','Email','City','Prospect ask','Sponsor','Table','Relationship']].concat(sortRows(dView,dState).map(d=>[legal||!d.anon?d.name:d.display,d.display,d.anon?'yes':'',d.total/100,d.count,d.pledged/100,d.paid/100,d.firstLabel,d.email,d.city,d.prospect?d.prospect.ask/100:'',d.sponsor,d.table,d.rel])),'donors.csv');});

}
if(document.getElementById('gift-table')){
const gState={key:'t',dir:'asc',limit:PAGE};let gView=[];
function renderGifts(){const q=$('#gift-q').value.trim().toLowerCase();const f=$('#gift-f').value;const legal=$('#gift-legal').checked;
 gView=R.gifts.filter(g=>{if(f==='active'&&g.status!=='active')return false;if(f==='voided'&&g.status!=='voided')return false;if(f==='pledge'&&g.method!=='pledge')return false;if(f==='online'&&g.source!=='online')return false;if(f==='amended'&&!g.amended)return false;if(f==='anon'&&!g.anon)return false;if(f==='notes'&&!g.notes)return false;if(!q)return true;return [legal||!g.anon?g.donor:'',g.display,g.by,g.notes,g.email,g.city,g.table,g.seated].join(' ').toLowerCase().includes(q);});
 const rows=sortRows(gView,gState);$('#gift-count').textContent=rows.length+' entries · '+usd0(rows.filter(g=>g.status==='active').reduce((s,g)=>s+g.amount,0))+' active';
 const shown=paged(rows,gState,$('#gift-more'),renderGifts);
 $('#gift-table tbody').innerHTML=shown.map(g=>{const flags=[];if(g.status==='voided')flags.push(pill('deleted','red'));if(g.amended)flags.push(pill('was '+usd0(g.original),'orange'));if(g.anon)flags.push(pill('anon','gold'));if(g.recurring)flags.push(pill('monthly','green'));if(g.restriction==='Zakat')flags.push(pill('zakat','green'));if(g.prospect&&(legal||!g.anon))flags.push(pill('prospect','navy'));if(g.seated&&(legal||!g.anon))flags.push(pill('table '+g.seated.split(':')[0]));
  return '<tr'+(g.status==='voided'?' style="opacity:.55"':'')+'><td class="name">'+esc(g.anon&&!legal?g.display:g.donor)+'<span class="sub">'+esc(g.time)+'</span></td>'+td('Amount','<b>'+usd(g.amount)+'</b>','r amt')+td('Method',esc(g.method))+td('Source',esc(g.source))+td('Recorded by',esc(g.by))+td('Flags',flags.join(''))+td('Note',esc(g.notes),'dim')+'</tr>';}).join('');}
['#gift-q','#gift-f','#gift-legal'].forEach(s=>$(s).addEventListener('input',()=>{gState.limit=PAGE;renderGifts();}));sortable($('#gift-table'),gState,renderGifts);renderGifts();
$('#gift-csv').addEventListener('click',()=>csv([['Time','Donor','Display','Anonymous','Amount','Method','Source','Recorded by','Status','Corrected from','Note','Restriction','Recurring','City']].concat(sortRows(gView,gState).map(g=>[g.time,g.donor,g.display,g.anon?'yes':'',g.amount/100,g.method,g.source,g.by,g.status,g.amended?g.original/100:'',g.notes,g.restriction,g.recurring?'monthly':'',g.city])),'gifts.csv'));

}
if(document.getElementById('prospect-table')){
const pState={key:'ask',dir:'desc'};
function renderProspects(){const rows=sortRows(R.prospects.map(p=>({...p,delta:p.ask&&p.actual!==null?p.actual-p.ask:null})),pState);
 $('#prospect-table tbody').innerHTML=rows.map(p=>{const st=p.actual===null?pill('no gift recorded','red'):p.ask&&p.actual<p.ask?pill('below ask','orange'):p.ask?pill('met ask','green'):pill('gave','green');
  return '<tr><td class="name">'+esc(p.name)+(p.matched&&p.matched!==p.name?'<span class="sub">matched: '+esc(p.matched)+'</span>':'')+'</td>'+td('Earlier 2026',p.before?usd0(p.before):'','r')+td('Ask',p.ask?usd0(p.ask):'','r')+td('Assumed',p.assumed?usd0(p.assumed):'','r')+td('Gave tonight',p.actual!==null?'<b>'+usd0(p.actual)+'</b>'+(p.anon?' '+pill('anon','gold'):''):'','r')+td('vs. ask',p.delta!==null?'<span style="color:'+(p.delta<0?'var(--red)':'var(--green)')+'">'+(p.delta>0?'+':'')+usd0(p.delta)+'</span>':'','r')+td('Status',st)+td('Notes',esc(p.notes),'dim')+'</tr>';}).join('');}
sortable($('#prospect-table'),pState,renderProspects);renderProspects();
$('#table-table tbody').innerHTML=R.tables.map(t=>'<tr><td class="name">Table '+esc(t.number)+'</td>'+td('Host',esc(t.host)+'<span class="sub">'+esc(t.donors.join(', '))+'</span>')+td('Gifts',t.count,'r')+td('Raised','<b>'+usd0(t.raised)+'</b>','r')+'</tr>').join('');
$('#sponsor-table tbody').innerHTML=R.sponsors.filter(s=>s.gave!==null).sort((a,b)=>b.gave-a.gave).map(s=>'<tr><td class="name">'+esc(s.org)+'<span class="sub">'+esc(s.donor)+'</span></td>'+td('Tier',esc(s.tier))+td('Package',usd0(s.cost),'r')+td('Appeal gift','<b>'+usd0(s.gave)+'</b>','r')+'</tr>').join('')||'<tr><td class="dim">No sponsor matched an appeal gift by name.</td></tr>';

}
if(document.getElementById('pledge-table')){
$('#pledge-table tbody').innerHTML=R.donors.filter(d=>d.pledged).sort((a,b)=>b.pledged-a.pledged).map(d=>'<tr><td class="name">'+esc(d.anon?d.display+' (anonymous)':d.name)+'</td>'+td('Pledged','<b>'+usd0(d.pledged)+'</b>','r amt')+td('Recorded by',esc(d.by))+td('Table',esc(d.table),'dim')+'</tr>').join('');
$('#missing-table tbody').innerHTML=R.stats.prospects_missing.sort((a,b)=>b.ask-a.ask).map(p=>'<tr><td class="name">'+esc(p.name)+'</td>'+td('Ask','<b>'+usd0(p.ask)+'</b>','r amt')+td('Notes',esc(p.notes),'dim')+'</tr>').join('');
$('#declined-table tbody').innerHTML=R.declined.map(t=>'<tr><td class="name">'+esc(t.name)+'<span class="sub">'+esc(t.email)+'</span></td>'+td('Time',esc(t.time),'dim')+td('Amount',usd(t.amount),'r')+td('Payment',esc(t.payment),'dim')+'</tr>').join('')||'<tr><td class="dim">No declined attempts.</td></tr>';
const tState={limit:PAGE};function renderTickets(){const shown=paged(R.tickets_no_gift,tState,$('#ticket-more'),renderTickets);$('#ticket-table tbody').innerHTML=shown.map(t=>'<tr><td class="name">'+esc(t.name)+'</td>'+td('Email',esc(t.email),'dim')+td('Tickets',t.tickets,'r')+td('Order',esc(t.items),'dim')+'</tr>').join('');}renderTickets();
if(document.getElementById('bloom-table'))$('#bloom-table tbody').innerHTML=R.donors.filter(d=>d.bloomerang).map(d=>{const b=d.bloomerang;return '<tr><td class="name">'+esc(d.anon?d.display:d.name)+'</td>'+td('Tonight','<b>'+usd0(d.total)+'</b>','r amt')+td('Lifetime',usd0(b.lifetime),'r')+td('Gifts',b.count,'r')+td('First gift',esc(b.first))+td('Last gift',esc(b.last)+' · '+usd0(b.lastAmount))+td('Last gala',b.gala?usd0(b.gala):'','r')+td('Years',esc(b.years.join(', ')),'dim')+'</tr>';}).join('');

}
// Charts: inline SVG sized to the container, re-drawn on resize.
const svg=(w,h,inner)=>'<svg class="chart" viewBox="0 0 '+w+' '+h+'" width="'+w+'" height="'+h+'" style="aspect-ratio:'+w+'/'+h+'" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="goldfade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C59B27" stop-opacity=".35"/><stop offset="1" stop-color="#C59B27" stop-opacity="0"/></linearGradient></defs>'+inner+'</svg>';
const widthOf=id=>Math.max(300,Math.floor(document.getElementById(id).clientWidth||600));
const short=c=>c>=1e8?'$'+(c/1e8).toFixed(1).replace(/\\.0$/,'')+'M':c>=1e5?'$'+Math.round(c/1e5)+'k':usd0(c);
function timeline(){const T=R.stats.timeline;if(!T.length)return;const W=widthOf('chart-timeline'),narrow=W<560,H=narrow?240:300,L=narrow?30:48,Rm=narrow?46:64,top=18,bot=narrow?34:44;const iw=W-L-Rm,ih=H-top-bot;const maxC=Math.max(1,...T.map(b=>b.count));const maxCum=Math.max(1,...T.map(b=>b.cumulative));const bw=iw/T.length;
 let out='';for(let i=0;i<=4;i++){const y=top+ih-ih*i/4;out+='<line class="axis" x1="'+L+'" x2="'+(W-Rm)+'" y1="'+y+'" y2="'+y+'"/><text x="'+(L-6)+'" y="'+(y+4)+'" text-anchor="end">'+Math.round(maxC*i/4)+'</text><text x="'+(W-Rm+6)+'" y="'+(y+4)+'">'+short(maxCum*i/4)+'</text>';}
 const every=Math.ceil(T.length/(narrow?5:12));
 T.forEach((b,i)=>{const h=ih*b.count/maxC;out+='<rect class="bar" x="'+(L+i*bw+1)+'" y="'+(top+ih-h)+'" width="'+Math.max(1,bw-2)+'" height="'+h+'"><title>'+esc(b.label)+': '+b.count+' gifts, '+usd0(b.cents)+'</title></rect>';if(i%every===0)out+='<text x="'+(L+i*bw+bw/2)+'" y="'+(H-bot+16)+'" text-anchor="middle">'+esc(b.label)+'</text>';});
 const pts=T.map((b,i)=>[L+i*bw+bw/2,top+ih-ih*b.cumulative/maxCum]);out+='<path class="area" d="M'+pts[0][0]+','+(top+ih)+' '+pts.map(p=>'L'+p[0]+','+p[1]).join(' ')+' L'+pts[pts.length-1][0]+','+(top+ih)+'Z"/><path class="line" d="M'+pts.map(p=>p[0]+','+p[1]).join(' L')+'"/>';
 if(!narrow)R.milestones.filter(m=>m.reached_at).forEach(m=>{const y=top+ih-ih*m.cents/maxCum;if(y<top||y>top+ih)return;out+='<line x1="'+L+'" x2="'+(W-Rm)+'" y1="'+y+'" y2="'+y+'" stroke="#C59B27" stroke-dasharray="3 4" stroke-width="1"/><text class="lbl" x="'+(L+6)+'" y="'+(y-4)+'">'+esc(m.label.toUpperCase())+'</text>';});
 out+='<text class="lbl" x="'+L+'" y="'+(H-4)+'">GIFTS / 15 MIN</text><text class="lbl" x="'+(W-Rm)+'" y="'+(H-4)+'" text-anchor="end">RUNNING TOTAL</text>';$('#chart-timeline').innerHTML=svg(W,H,out);}
function bands(){const B=R.stats.bands;const W=widthOf('chart-bands'),rowH=30,L=Math.min(150,W*.32),H=B.length*rowH+20;const max=Math.max(1,...B.map(b=>b.cents));let out='';B.forEach((b,i)=>{const y=6+i*rowH;const w=Math.max(2,(W-L-100)*b.cents/max);out+='<text x="'+(L-8)+'" y="'+(y+19)+'" text-anchor="end">'+esc(b.label)+'</text><rect class="bar gold" x="'+L+'" y="'+(y+5)+'" width="'+w+'" height="'+(rowH-11)+'" rx="2"/><text x="'+(L+w+6)+'" y="'+(y+19)+'">'+short(b.cents)+' · '+b.count+'</text>';});$('#chart-bands').innerHTML=svg(W,H,out);}
function mix(){const S=R.stats;const W=widthOf('chart-mix');const parts=[['Ballroom pledges',S.pledge_cents,'#1E2A4A'],['Online cards',S.online_cents,'#C59B27'],['Other paid in room',S.manual_paid_cents,'#7C9AC0']].filter(p=>p[1]>0);const total=parts.reduce((s,p)=>s+p[1],0);let x=0,out='';parts.forEach(p=>{const w=W*p[1]/total;out+='<rect x="'+x+'" y="6" width="'+w+'" height="34" fill="'+p[2]+'"/>';if(w>60)out+='<text x="'+(x+8)+'" y="28" style="fill:#fff;font-weight:600">'+Math.round(100*p[1]/total)+'%</text>';x+=w;});let y=64;parts.forEach(p=>{out+='<rect x="0" y="'+(y-10)+'" width="10" height="10" rx="2" fill="'+p[2]+'"/><text x="16" y="'+y+'">'+esc(p[0])+' · '+usd0(p[1])+'</text>';y+=18;});const z=S.zakat_cents,g=S.general_cents;if(z+g){out+='<text class="lbl" x="0" y="'+(y+12)+'">ONLINE RESTRICTION</text>';const zw=W*z/(z+g);out+='<rect x="0" y="'+(y+20)+'" width="'+zw+'" height="22" fill="#2F6B3A"/><rect x="'+zw+'" y="'+(y+20)+'" width="'+(W-zw)+'" height="22" fill="#D8D3C8"/><text x="0" y="'+(y+58)+'">Zakat '+usd0(z)+' ('+Math.round(100*z/(z+g))+'%) · General '+usd0(g)+'</text>';y+=70;}$('#chart-mix').innerHTML=svg(W,y+4,out);}
function pareto(){const D=R.donors.map(d=>d.total);const total=D.reduce((s,v)=>s+v,0);if(!total)return;const W=widthOf('chart-pareto'),H=170,L=40,top=10,ih=120;let cum=0;const pts=D.map((v,i)=>{cum+=v;return [L+(W-L-10)*(i+1)/D.length,top+ih-ih*cum/total];});let out='<line class="axis" x1="'+L+'" x2="'+(W-10)+'" y1="'+(top+ih)+'" y2="'+(top+ih)+'"/>';[0.5,0.8,1].forEach(f=>{const y=top+ih-ih*f;out+='<line class="axis" x1="'+L+'" x2="'+(W-10)+'" y1="'+y+'" y2="'+y+'" stroke-dasharray="2 4"/><text x="'+(L-6)+'" y="'+(y+4)+'" text-anchor="end">'+Math.round(f*100)+'%</text>';});out+='<path class="line" d="M'+L+','+(top+ih)+' L'+pts.map(p=>p[0]+','+p[1]).join(' L')+'"/>';let run=0,n50=0;for(let i=0;i<D.length;i++){run+=D[i];if(run>=total/2){n50=i+1;break;}}out+='<text class="lbl" x="'+L+'" y="'+(H-8)+'">'+n50+' OF '+D.length+' HOUSEHOLDS GAVE HALF THE TOTAL</text>';$('#chart-pareto').innerHTML=svg(W,H,out);}
function charts(){if(document.getElementById('chart-timeline')){timeline();bands();mix();pareto();}}charts();let rt;window.addEventListener('resize',()=>{clearTimeout(rt);rt=setTimeout(charts,150);});

// Scroll-spy for the top nav.
const links=[...document.querySelectorAll('.topnav a[href^="index.html#"]')];const secs=links.map(a=>document.getElementById(a.getAttribute('href').split('#')[1])).filter(Boolean);
if('IntersectionObserver' in window){const io=new IntersectionObserver(es=>{es.forEach(e=>{if(!e.isIntersecting)return;links.forEach(a=>a.classList.toggle('on',a.getAttribute('href').endsWith('#'+e.target.id)));const on=document.querySelector('.topnav a.on');if(on)on.scrollIntoView({block:'nearest',inline:'center',behavior:'smooth'});});},{rootMargin:'-40% 0px -55% 0px'});secs.forEach(s=>io.observe(s));}
})();
</script>
</body></html>`;
  return { index: head + topbar("index.html") + body + script, donors: head + topbar("donors.html") + donorsBody + script };
}
