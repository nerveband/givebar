// Single-file interactive report in the gala booklet's visual language (cream page, navy and
// gold, Brandon Grotesque display, Plus Jakarta Sans body, Space Mono figures). Fonts, logos,
// and QR codes are inlined so the file works offline, behind the share password, and as the
// print source for the PDF (@media print).
import { readFileSync } from "fs";
import { join } from "path";
import { generateQRCodeSVG } from "../../server/src/routes/qr";
import type { Report, Gift, Donor } from "./data";
import { fmtMoney, localTime } from "./data";

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
  const donor = (d: Donor) => ({ key: d.key, name: d.name, display: d.display_name, anon: d.is_anonymous, total: d.total_cents, count: d.gifts.length, pledged: d.pledged_cents, paid: d.paid_cents, largest: d.largest_cents, tier: d.tier, first: d.first_gift_at, firstLabel: localTime(d.first_gift_at, r.config.timezone), rel: d.relationship, email: d.email, city: d.city, restriction: d.restriction, sources: d.sources.join("+"), prospect: d.prospect ? { name: d.prospect.name, ask: d.prospect.ask_cents, assumed: d.prospect.assumed_cents, before: d.prospect.gave_before_cents, notes: d.prospect.notes } : null, sponsor: d.sponsor ? `${d.sponsor.org} (${d.sponsor.tier})` : "", ticket: d.ticket ? `${d.ticket.tickets} ticket(s)` : "", table: d.table ? `${d.table.number}: ${d.table.host}` : "", bloomerang: d.bloomerang ? { lifetime: d.bloomerang.lifetime_cents, count: d.bloomerang.gift_count, first: d.bloomerang.first_gift.slice(0, 10), last: d.bloomerang.last_gift.slice(0, 10), lastAmount: d.bloomerang.last_gift_cents, gala: d.bloomerang.last_gala_cents, years: d.bloomerang.years_active } : null, notes: d.gifts.map(g => g.notes).filter(Boolean).join(" | ") });
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

export function renderHTML(r: Report): string {
  const s = r.stats; const c = r.config; const view = viewPayload(r);
  const generated = localTime(new Date(r.generated_at).getTime(), c.timezone, { dateStyle: "long", timeStyle: "short" });
  const eventDate = new Date(`${c.event_date}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const links = [
    { label: "Donate page", url: c.donate_url, note: "The public donation form (Qgiv). Same link the ballroom QR pointed to." },
    { label: "Givebar (sign-in only)", url: c.givebar_url, note: "Live ledger, history, stats, CSV export. Every page requires an operator account." },
    { label: "This report", url: c.share_url, note: "Password-protected. Re-published in place when the data is refreshed." },
    { label: c.client, url: c.org_url, note: "Organisation website." }
  ];
  const kpi = (label: string, value: string, sub = "") => `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value num">${esc(value)}</div>${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ""}</div>`;
  const kindLabel: Record<string, string> = { win: "Win", action: "Action", watch: "Watch", insight: "Insight" };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(r.event.name)} · Donor Report</title>
<style>
${font("Brandon", "Brandon_light.otf", 300)}${font("Brandon", "Brandon_reg.otf", 400)}${font("Brandon", "Brandon_med.otf", 500)}${font("Brandon", "Brandon_bld.otf", 700)}${font("Brandon", "Brandon_blk.otf", 900)}
${font("Jakarta", "plus-jakarta-sans-400.ttf", 400)}${font("Jakarta", "plus-jakarta-sans-400-italic.ttf", 400, "italic")}${font("Jakarta", "plus-jakarta-sans-600.ttf", 600)}${font("Jakarta", "plus-jakarta-sans-700.ttf", 700)}
${font("Mono", "space-mono-400.ttf", 400)}${font("Mono", "space-mono-700.ttf", 700)}
:root{--cream:#F7F4EE;--paper:#FFFDF8;--navy:#1E2A4A;--navy-deep:#0E1730;--ink:#0F172A;--slate:#334155;--muted:#64748B;--gold:#C59B27;--gold-dark:#926310;--gold-light:#E5C578;--orange:#F89728;--blue:#1B4D89;--sky:#7C9AC0;--line:#D8D3C8;--red:#B4232C;--green:#2F6B3A;--display:"Brandon","Plus Jakarta Sans",sans-serif;--body:"Jakarta","Plus Jakarta Sans",system-ui,sans-serif;--mono:"Mono","Space Mono",ui-monospace,monospace}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--cream);color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
a{color:var(--blue)}h1,h2,h3{font-family:var(--display);color:var(--navy);margin:0;line-height:1.05;text-transform:uppercase;letter-spacing:.01em}
h2{font-size:30px;font-weight:900}h2 em{font-style:normal;color:var(--gold)}h3{font-size:17px;font-weight:700;letter-spacing:.06em;color:var(--gold-dark);margin:26px 0 10px}
.eyebrow{font-family:var(--display);font-weight:700;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--navy)}.eyebrow.gold{color:var(--gold-dark)}
nav.toc{position:sticky;top:0;z-index:5;background:rgba(247,244,238,.94);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:8px 24px;display:flex;gap:4px 18px;flex-wrap:wrap;font-family:var(--display);font-weight:700;font-size:12px;letter-spacing:.12em;text-transform:uppercase}
nav.toc a{color:var(--navy);text-decoration:none;padding:4px 0}nav.toc a:hover{color:var(--gold-dark)}
.page{max-width:1120px;margin:28px auto;background:var(--paper);padding:44px 48px 40px;position:relative;box-shadow:0 1px 0 rgba(30,42,74,.06),0 12px 40px rgba(30,42,74,.08)}
.page::before{content:"";position:absolute;inset:14px;border:1px solid var(--gold);pointer-events:none}
.page::after{content:"";position:absolute;inset:14px;pointer-events:none;background:radial-gradient(circle at 0 0,var(--gold) 0 3px,transparent 4px),radial-gradient(circle at 100% 0,var(--gold) 0 3px,transparent 4px),radial-gradient(circle at 0 100%,var(--gold) 0 3px,transparent 4px),radial-gradient(circle at 100% 100%,var(--gold) 0 3px,transparent 4px)}
.page-head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--navy);padding-bottom:8px;margin-bottom:22px}
.cover{background:linear-gradient(160deg,#0B1226 0%,#14203F 55%,#1E2A4A 100%);color:#fff;padding:64px 56px 48px;min-height:640px;display:flex;flex-direction:column;justify-content:space-between}
.cover::before{border-color:var(--gold-light);opacity:.7}.cover .eyebrow{color:var(--gold-light)}.cover h1{color:#fff;font-size:54px;font-weight:900;max-width:820px}.cover h1 span{display:block;background:linear-gradient(135deg,#FDE6B0 0%,#E5C578 45%,#C59B27 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.cover .logo{height:64px;width:auto;background:#fff;padding:10px 16px;border-radius:6px}.cover-total{font-family:var(--mono);font-size:64px;font-weight:700;letter-spacing:-.01em;color:#FDE6B0;line-height:1}.cover-goal{color:#C9D3E8;font-size:15px;margin-top:8px}
.cover-foot{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;border-top:1px solid rgba(229,197,120,.45);padding-top:18px;font-size:13px;color:#C9D3E8}.cover-foot .wd{height:22px;width:auto}
.prepared{display:flex;align-items:center;gap:12px}.prepared small{display:block;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8FA3C7}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:8px 0 24px}.kpi{border:1px solid var(--line);border-top:3px solid var(--gold);background:var(--cream);padding:12px 14px}.kpi-label{font-family:var(--display);font-weight:700;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--navy)}.kpi-value{font-size:26px;font-weight:700;color:var(--ink);margin-top:4px;line-height:1.1}.kpi-sub{font-size:12px;color:var(--muted);margin-top:4px}
.lead{font-size:17px;color:var(--slate);max-width:820px;margin:0 0 18px}
.take{display:grid;grid-template-columns:1fr 1fr;gap:14px}.take article{border:1px solid var(--line);background:#fff;padding:14px 16px;border-left:4px solid var(--gold);break-inside:avoid}.take article.action{border-left-color:var(--orange)}.take article.win{border-left-color:var(--green)}.take article.watch{border-left-color:var(--red)}
.take .tag{font-family:var(--display);font-weight:700;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold-dark)}.take article.action .tag{color:var(--orange)}.take article.win .tag{color:var(--green)}.take article.watch .tag{color:var(--red)}.take h4{font-family:var(--body);font-weight:700;font-size:15px;margin:4px 0 6px;color:var(--navy)}.take p{margin:0;font-size:13.5px;color:var(--slate)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:26px}.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px}
.chart{width:100%;height:auto;display:block}.chart text{font-family:var(--mono);font-size:11px;fill:var(--slate)}.chart .axis{stroke:var(--line)}.chart .bar{fill:var(--navy)}.chart .bar.gold{fill:var(--gold)}.chart .line{fill:none;stroke:var(--gold-dark);stroke-width:2}.chart .area{fill:url(#goldfade)}.chart .lbl{font-family:var(--display);font-weight:700;font-size:11px;letter-spacing:.06em;fill:var(--navy)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--slate);margin-top:6px}.legend i{display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:-1px}
table{width:100%;border-collapse:collapse;font-size:13px}th{font-family:var(--display);font-weight:700;font-size:11px;letter-spacing:.12em;text-transform:uppercase;text-align:left;color:var(--navy);border-bottom:2px solid var(--gold);padding:8px 8px;white-space:nowrap;cursor:pointer;user-select:none;position:sticky;top:44px;background:var(--paper)}th.r,td.r{text-align:right}th[data-dir]::after{content:" ▾";color:var(--gold-dark)}th[data-dir="asc"]::after{content:" ▴"}
td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}tr:nth-child(even) td{background:rgba(247,244,238,.6)}td.name{font-weight:600;color:var(--navy)}td.dim{color:var(--muted)}
.pill{display:inline-block;font-family:var(--display);font-weight:700;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:2px 7px;border-radius:3px;background:var(--cream);border:1px solid var(--line);color:var(--slate);margin-right:4px;white-space:nowrap}.pill.gold{background:#FBF3DC;border-color:var(--gold-light);color:var(--gold-dark)}.pill.navy{background:var(--navy);border-color:var(--navy);color:#fff}.pill.red{background:#FBE7E8;border-color:#E9A6AA;color:var(--red)}.pill.green{background:#E8F3EA;border-color:#A9CDB1;color:var(--green)}.pill.orange{background:#FDEEDC;border-color:#F8C58C;color:#A85A00}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0 10px;font-size:13px}.toolbar input[type=search]{font:inherit;padding:8px 12px;border:1px solid var(--line);background:#fff;min-width:260px;border-radius:4px}.toolbar select{font:inherit;padding:7px 10px;border:1px solid var(--line);background:#fff;border-radius:4px}.toolbar label{display:inline-flex;align-items:center;gap:6px;color:var(--slate)}.toolbar .count{margin-left:auto;color:var(--muted);font-family:var(--mono);font-size:12px}
.toolbar button,button.btn{font-family:var(--display);font-weight:700;font-size:11px;letter-spacing:.12em;text-transform:uppercase;background:var(--navy);color:#fff;border:0;padding:9px 14px;border-radius:4px;cursor:pointer}.toolbar button.ghost{background:#fff;color:var(--navy);border:1px solid var(--navy)}
.scroll{max-height:640px;overflow:auto;border:1px solid var(--line)}.scroll th{top:0}
.links{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.link{border:1px solid var(--line);background:#fff;padding:14px;text-align:center}.link .qr{width:140px;height:140px;display:block;margin:0 auto 10px}.link b{display:block;font-family:var(--display);text-transform:uppercase;letter-spacing:.08em;font-size:12px;color:var(--navy)}.link a{font-family:var(--mono);font-size:11px;word-break:break-all}.link p{font-size:12px;color:var(--muted);margin:6px 0 0}
.note{background:var(--cream);border:1px solid var(--line);padding:12px 14px;font-size:13px;color:var(--slate)}.note.warn{border-color:#F8C58C;background:#FDF5E9}
.foot{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:28px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}.foot img{height:18px;opacity:.85}
.bloom-off{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:center}
dl.spec{display:grid;grid-template-columns:220px 1fr;gap:6px 14px;font-size:13px;margin:0}dl.spec dt{font-weight:700;color:var(--navy)}dl.spec dd{margin:0;color:var(--slate)}
.hide-print{}
@media (max-width:860px){.kpis,.take,.grid2,.grid3,.links{grid-template-columns:1fr 1fr}.page{padding:28px 20px}th{top:0}}
@media (max-width:560px){.kpis,.take,.grid2,.grid3,.links{grid-template-columns:1fr}.cover h1{font-size:36px}.cover-total{font-size:44px}}
@media print{
  @page{size:letter;margin:0.45in}
  body{background:#fff;font-size:11.5px}nav.toc,.toolbar,.hide-print{display:none!important}
  .page{max-width:none;margin:0;box-shadow:none;padding:28px 30px;break-after:page;page-break-after:always}.page:last-child{break-after:auto}.page::before{inset:6px}.page::after{inset:6px}
  .cover{min-height:9.4in;-webkit-print-color-adjust:exact;print-color-adjust:exact}.cover h1{font-size:44px}
  .kpi,.take article,.pill,.chart .bar,.cover,.link{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .scroll{overflow:visible;border:0}th{position:static}table{font-size:10.5px}td,th{padding:4px 6px}
  h2{font-size:24px}.kpi-value{font-size:20px}.take{grid-template-columns:1fr 1fr}
  .grid2,.grid3{display:block}.grid2>div,.grid3>div{margin-bottom:18px}.scroll{max-height:none!important}
  #chart-timeline svg{height:2.7in}#chart-bands svg{height:2.4in}#chart-mix svg{height:1.9in}#chart-pareto svg{height:1.7in}h3{break-after:avoid}
  tr{break-inside:avoid}.print-limit tbody tr:nth-child(n+41){display:none}.print-limit::after{content:"Showing the first 40 rows; the full list is in the workbook and the interactive report.";display:block;font-size:10px;color:#64748B;margin-top:6px}
}
</style></head>
<body>
<nav class="toc hide-print"><a href="#summary">Summary</a><a href="#takeaways">Takeaways</a><a href="#charts">Charts</a><a href="#donors">Donors</a><a href="#gifts">Gifts</a><a href="#crossref">Cross-reference</a><a href="#followup">Follow-up</a><a href="#bloomerang">Bloomerang</a><a href="#links">Links &amp; QR</a><a href="#method">Method</a><span style="margin-left:auto;display:flex;gap:14px"><a href="${esc(c.output_basename)}.xlsx" download>Workbook (xlsx)</a><a href="${esc(c.output_basename)}.pdf" download>PDF</a></span><span style="font-weight:400;letter-spacing:0;text-transform:none;color:var(--muted)">Generated ${esc(generated)}</span></nav>

<section class="page cover">
  <div>
    <img class="logo" alt="${esc(c.client)}" src="data:image/png;base64,${b64("cair-georgia-logo.png")}">
    <div class="eyebrow" style="margin-top:36px">${esc(c.client)} · ${esc(eventDate)}</div>
    <h1 style="margin-top:10px">${esc(r.event.subtitle || c.event_short)}<span>Donor Report</span></h1>
  </div>
  <div>
    <div class="eyebrow">Raised on the night</div>
    <div class="cover-total">${esc(money0(s.total_cents))}</div>
    <div class="cover-goal">${esc(pct(s.pct_of_goal))} of the ${esc(money0(s.goal_cents))} goal · ${s.active_count} gifts · ${s.households} donor households · ${esc(money0(s.pledge_cents))} in pledges to collect</div>
  </div>
  <div class="cover-foot">
    <div class="prepared"><div><small>Prepared by</small><img class="wd" alt="wavedepth" src="data:image/svg+xml;base64,${wdLogo("#FFFFFF")}"></div></div>
    <div style="text-align:right">Internal document for the ${esc(c.client)} team.<br>Contains donor names, pledges, and staff notes. Do not forward.</div>
  </div>
</section>

<section class="page" id="summary">
  <div class="page-head"><span class="eyebrow">${esc(c.event_short)} · Donor Report</span><span class="eyebrow gold">Summary</span></div>
  <h2>The night <em>in numbers</em></h2>
  <p class="lead">Every figure below comes from the Givebar ledger (an append-only record of every gift, correction, and deletion), the Qgiv online form behind the QR code, and the staff MASTER workbook. Times are ${esc(c.timezone.replace("_", " "))}.</p>
  <div class="kpis">
    ${kpi("Total raised", money0(s.total_cents), `${pct(s.pct_of_goal)} of ${money0(s.goal_cents)} goal`)}
    ${kpi("Gifts", String(s.active_count), `${s.households} households · ${s.void_count} deleted`)}
    ${kpi("Ballroom pledges", money0(s.pledge_cents), `${s.pledge_count} pledges · to collect`)}
    ${kpi("Online (settled)", money0(s.online_cents), `${s.online_count} card gifts · net ${money0(s.net_online_cents)}`)}
    ${kpi("Average gift", money0(s.avg_cents), `median ${money0(s.median_cents)}`)}
    ${kpi("Major gifts", money0(s.major_cents), `${s.major_count} at ${money0(r.event.major_gift_threshold_cents)}+`)}
    ${kpi("Top 10 gifts", pct(s.top10_pct), `${money0(s.top10_cents)} of the total`)}
    ${kpi("Anonymous", money0(s.anonymous_cents), `${s.anonymous_count} gifts`)}
    ${kpi("Zakat (online)", money0(s.zakat_cents), `${s.zakat_count} gifts · ${pct(s.zakat_cents / (s.online_cents || 1))} of online`)}
    ${kpi("Monthly donors", String(s.recurring_count), `${money0(s.recurring_monthly_cents)} / month started`)}
    ${kpi("Fees covered by donors", money0(s.gift_assist_cents), `of ${money0(s.fees_cents)} charged`)}
    ${kpi("Declined online", String(s.declined_count), `${money0(s.declined_cents)} attempted`)}
  </div>
  <div class="grid2">
    <div><h3>Milestones</h3><table><thead><tr><th>Level</th><th class="r">Amount</th><th>Reached</th></tr></thead><tbody>${r.milestones.map(m => `<tr><td class="name">${esc(m.label)}</td><td class="r num">${esc(money0(m.cents))}</td><td>${m.reached_at ? esc(localTime(m.reached_at, c.timezone, { hour: "numeric", minute: "2-digit" })) : '<span class="pill">not reached</span>'}</td></tr>`).join("")}</tbody></table></div>
    <div><h3>Quick amounts (ask tiers)</h3><table><thead><tr><th>Tier</th><th class="r">Gifts at exactly this amount</th></tr></thead><tbody>${r.ask_tiers.map(t => `<tr><td class="name num">${esc(t.label)}</td><td class="r num">${t.hits}</td></tr>`).join("")}</tbody></table>
    <h3>Who recorded</h3><table><thead><tr><th>Source</th><th class="r">Gifts</th><th class="r">Amount</th></tr></thead><tbody>${s.operators.map(o => `<tr><td class="name">${esc(o.name)}</td><td class="r num">${o.count}</td><td class="r num">${esc(money0(o.cents))}</td></tr>`).join("")}</tbody></table></div>
  </div>
</section>

<section class="page" id="takeaways">
  <div class="page-head"><span class="eyebrow">${esc(c.event_short)} · Donor Report</span><span class="eyebrow gold">Takeaways</span></div>
  <h2>What to do <em>this week</em></h2>
  <p class="lead">Generated from the numbers, ordered by money at stake. Each card names the list to work from in the workbook.</p>
  <div class="take">${r.takeaways.map(t => `<article class="${t.kind}"><span class="tag">${esc(kindLabel[t.kind])}</span><h4>${esc(t.title)}</h4>${t.body ? `<p>${esc(t.body)}</p>` : ""}</article>`).join("")}</div>
</section>

<section class="page" id="charts">
  <div class="page-head"><span class="eyebrow">${esc(c.event_short)} · Donor Report</span><span class="eyebrow gold">Charts</span></div>
  <h2>How the night <em>unfolded</em></h2>
  <h3>Running total and gifts per 15 minutes</h3>
  <div id="chart-timeline"></div>
  <div class="legend"><span><i style="background:var(--navy)"></i>Gifts in window (count)</span><span><i style="background:var(--gold-dark)"></i>Running total</span>${s.peak ? `<span>Peak window: <b class="num">${esc(s.peak.label)}</b> · ${esc(money0(s.peak.cents))} across ${s.peak.count} gifts</span>` : ""}</div>
  <div class="grid2" style="margin-top:22px">
    <div><h3>Gift size bands</h3><div id="chart-bands"></div></div>
    <div><h3>Where the money came from</h3><div id="chart-mix"></div>
      <h3>Share of total by donor rank</h3><div id="chart-pareto"></div></div>
  </div>
</section>

<section class="page" id="donors">
  <div class="page-head"><span class="eyebrow">${esc(c.event_short)} · Donor Report</span><span class="eyebrow gold">Donors</span></div>
  <h2>Every donor <em>household</em></h2>
  <p class="lead">${s.households} households, largest first. Gifts from the same person across the ballroom form and the online form are combined. Search by name, email, city, table, or note.</p>
  <div class="toolbar"><input type="search" id="donor-q" placeholder="Search donors"><select id="donor-f"><option value="">All donors</option><option value="pledge">Has pledge to collect</option><option value="online">Gave online</option><option value="anon">Anonymous</option><option value="prospect">On prospect list</option><option value="sponsor">Sponsor</option><option value="ticket">Ticket buyer</option><option value="repeat">Repeat (Bloomerang)</option><option value="new">First-time (Bloomerang)</option><option value="major">Major gift</option></select><label><input type="checkbox" id="donor-legal"> Show legal names of anonymous donors</label><label><input type="checkbox" id="donor-notes"> Show team notes</label><button class="ghost" id="donor-csv">Download view as CSV</button><span class="count" id="donor-count"></span></div>
  <div class="scroll print-limit"><table id="donor-table"><thead><tr><th data-k="name">Donor</th><th data-k="total" class="r">Total</th><th data-k="count" class="r">Gifts</th><th data-k="pledged" class="r">Pledged</th><th data-k="paid" class="r">Online</th><th data-k="first">First gift</th><th>Context</th><th data-k="rel">History</th></tr></thead><tbody></tbody></table></div>
</section>

<section class="page" id="gifts">
  <div class="page-head"><span class="eyebrow">${esc(c.event_short)} · Donor Report</span><span class="eyebrow gold">Gifts</span></div>
  <h2>Every gift, <em>in order</em></h2>
  <p class="lead">${r.gifts.length} ledger entries including ${s.void_count} deleted and ${s.amended_count} corrected. The workbook carries the full event log with every amendment.</p>
  <div class="toolbar"><input type="search" id="gift-q" placeholder="Search gifts"><select id="gift-f"><option value="">All entries</option><option value="active">Active only</option><option value="voided">Deleted only</option><option value="pledge">Pledges</option><option value="online">Online</option><option value="amended">Corrected</option><option value="anon">Anonymous</option><option value="notes">With team note</option></select><button class="ghost" id="gift-csv">Download view as CSV</button><span class="count" id="gift-count"></span></div>
  <div class="scroll print-limit"><table id="gift-table"><thead><tr><th data-k="t">Time</th><th data-k="donor">Donor</th><th data-k="amount" class="r">Amount</th><th data-k="method">Method</th><th data-k="source">Source</th><th data-k="by">Recorded by</th><th>Flags</th><th>Note</th></tr></thead><tbody></tbody></table></div>
</section>

<section class="page" id="crossref">
  <div class="page-head"><span class="eyebrow">${esc(c.event_short)} · Donor Report</span><span class="eyebrow gold">Cross-reference</span></div>
  <h2>Prospects, sponsors, <em>tables</em></h2>
  <p class="lead">Tonight's ledger against the staff MASTER workbook: the major-donor ask list, sponsorship packages, seating, and ticket orders. Matching is by name and email; a blank means no automatic match, not necessarily no gift.</p>
  <h3>Major-donor ask list vs. actual</h3>
  <div class="kpis" style="grid-template-columns:repeat(4,1fr)">${kpi("Prospects on list", String(s.prospects_total))}${kpi("Gave tonight", String(s.prospects_gave), `${money0(s.prospects_actual_cents)} recorded`)}${kpi("Asks on the list", money0(s.prospects_ask_cents))}${kpi("Below ask", String(s.prospects_under_ask.length), `${s.prospects_missing.length} with an ask and no gift`)}</div>
  <div class="scroll print-limit"><table id="prospect-table"><thead><tr><th data-k="name">Prospect</th><th data-k="before" class="r">Gave earlier 2026</th><th data-k="ask" class="r">Ask</th><th data-k="assumed" class="r">Assumed</th><th data-k="actual" class="r">Gave tonight</th><th data-k="delta" class="r">vs. ask</th><th>Status</th><th>Notes</th></tr></thead><tbody></tbody></table></div>
  <div class="grid2" style="margin-top:22px">
    <div><h3>Tables that gave</h3><div class="scroll print-limit" style="max-height:420px"><table id="table-table"><thead><tr><th>Table</th><th>Host</th><th class="r">Gifts</th><th class="r">Raised</th></tr></thead><tbody></tbody></table></div></div>
    <div><h3>Sponsors with an appeal gift</h3><div class="scroll print-limit" style="max-height:420px"><table id="sponsor-table"><thead><tr><th>Sponsor</th><th>Tier</th><th class="r">Package</th><th class="r">Appeal gift</th></tr></thead><tbody></tbody></table></div></div>
  </div>
</section>

<section class="page" id="followup">
  <div class="page-head"><span class="eyebrow">${esc(c.event_short)} · Donor Report</span><span class="eyebrow gold">Follow-up</span></div>
  <h2>Lists to <em>work from</em></h2>
  <div class="grid2">
    <div><h3>Pledges to collect · ${esc(money0(s.pledge_cents))}</h3><div class="scroll print-limit" style="max-height:520px"><table id="pledge-table"><thead><tr><th>Donor</th><th class="r">Pledged</th><th>Recorded by</th><th>Table</th></tr></thead><tbody></tbody></table></div></div>
    <div><h3>Prospects with an ask and no gift</h3><div class="scroll print-limit" style="max-height:520px"><table id="missing-table"><thead><tr><th>Prospect</th><th class="r">Ask</th><th>Notes</th></tr></thead><tbody></tbody></table></div>
      <h3>Declined online attempts</h3><div class="scroll" style="max-height:300px"><table id="declined-table"><thead><tr><th>Time</th><th>Name</th><th class="r">Amount</th><th>Payment</th></tr></thead><tbody></tbody></table></div></div>
  </div>
  <h3>Ticket buyers with no gift recorded (${view.tickets_no_gift.length})</h3>
  <div class="scroll print-limit" style="max-height:360px"><table id="ticket-table"><thead><tr><th>Name</th><th>Email</th><th class="r">Tickets</th><th>Order</th></tr></thead><tbody></tbody></table></div>
</section>

<section class="page" id="bloomerang">
  <div class="page-head"><span class="eyebrow">${esc(c.event_short)} · Donor Report</span><span class="eyebrow gold">Bloomerang</span></div>
  <h2>Giving <em>history</em></h2>
  ${r.bloomerang.connected
    ? `<p class="lead">${r.bloomerang.matched} of ${s.households} households matched a Bloomerang constituent (${r.bloomerang.constituents} constituents pulled ${esc(r.bloomerang.pulled_at.slice(0, 10))}). ${s.repeat_donors} repeat donors, ${s.new_donors} first-time donors.</p>
       <div class="scroll print-limit"><table id="bloom-table"><thead><tr><th data-k="name">Donor</th><th data-k="total" class="r">Tonight</th><th class="r">Lifetime</th><th class="r">Gifts</th><th>First gift</th><th>Last gift</th><th class="r">Last gala</th><th>Years</th></tr></thead><tbody></tbody></table></div>`
    : `<div class="note warn bloom-off"><div style="font-size:40px;line-height:1;color:var(--orange)">!</div><div><b>Not connected yet.</b> ${esc(r.bloomerang.message)}<br><br>What it adds to every donor row: repeat or first-time, first gift date, last gift date and amount, lifetime total, years active, and the gift made at last year's gala (${esc(c.previous_event_date)}). The columns already exist in the workbook and in the donor table above; they fill in on the next build.</div></div>`}
</section>

<section class="page" id="links">
  <div class="page-head"><span class="eyebrow">${esc(c.event_short)} · Donor Report</span><span class="eyebrow gold">Links &amp; QR</span></div>
  <h2>Links &amp; <em>QR codes</em></h2>
  <div class="links">${links.map(l => `<div class="link">${qr(l.url)}<b>${esc(l.label)}</b><a href="${esc(l.url)}">${esc(l.url.replace(/^https?:\/\//, ""))}</a><p>${esc(l.note)}</p></div>`).join("")}</div>
  <h3>Ballroom QR target</h3>
  <p class="note">The projector QR pointed to <span class="num">${esc(r.event.qr_url)}</span> (printed as <b>${esc(r.event.display_url)}</b>). Its UTM tags (source, medium, campaign, content) let the website analytics separate ballroom scans from email and social traffic.</p>
</section>

<section class="page" id="method">
  <div class="page-head"><span class="eyebrow">${esc(c.event_short)} · Donor Report</span><span class="eyebrow gold">Method</span></div>
  <h2>Sources &amp; <em>definitions</em></h2>
  <dl class="spec">
    <dt>Givebar ledger</dt><dd>VACUUM INTO snapshot of the production database taken ${esc(generated)}. Totals are the deterministic fold of every create, amend, void, and restore event. Rehearsal gifts are excluded.</dd>
    <dt>Online gifts</dt><dd>Qgiv form "${esc(r.qgiv.form_name)}" (${r.qgiv.all.length} transactions since January 1, pulled ${esc(r.qgiv.pulled_at.slice(0, 16).replace("T", " "))} UTC). Gift time is the Qgiv transaction time, not the import time. Amount is the gift net of donor-covered fees; fee and net columns are in the workbook.</dd>
    <dt>Pledges</dt><dd>Gifts recorded by staff in the ballroom with the Pledge method. They are commitments, not cash, until collected.</dd>
    <dt>Households</dt><dd>Gifts are grouped by first and last name after removing titles ("Dr.", "Household of") and splitting couples. Anonymous gifts with no legal name stay separate.</dd>
    <dt>Cross-reference</dt><dd>MASTER workbook sheets ${esc(Object.values(c.master_sheets).join(", "))}, matched by person name and, for online gifts, email. Automatic matching is conservative: verify before acting on a blank.</dd>
    <dt>Bloomerang</dt><dd>${r.bloomerang.connected ? `Constituents and transactions via the REST API; "last gala" is any gift within two weeks before to three weeks after ${esc(c.previous_event_date)} or tagged to a campaign or appeal named Gala.` : "Not connected; see the Bloomerang section."}</dd>
    <dt>Privacy</dt><dd>This report includes legal names of anonymous donors (hidden by default in the donor table), staff names, and team notes. It is for the ${esc(c.client)} team only. The public chart never showed any of these.</dd>
    <dt>Refreshing</dt><dd>Run <span class="num">bun reports/build-report.ts</span> after <span class="num">reports/pull-givebar.sh</span> (and the Qgiv/Bloomerang pulls). Outputs are rebuilt in place and re-published to the same password-protected link.</dd>
  </dl>
  <div class="foot"><span>${esc(r.event.name)} · Donor Report · generated ${esc(generated)}</span><span class="prepared" style="color:var(--slate)">Prepared by <img alt="wavedepth" src="data:image/svg+xml;base64,${wdLogo("#1E2A4A")}"></span></div>
</section>

<script id="report-data" type="application/json">${JSON.stringify(view).replace(/</g, "\\u003c")}</script>
<script>
(function(){
const R=JSON.parse(document.getElementById('report-data').textContent);
const $=s=>document.querySelector(s);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=c=>(c/100).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:c%100?2:0});const usd0=c=>(c/100).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
const pill=(t,k)=>'<span class="pill '+(k||'')+'">'+esc(t)+'</span>';
function csv(rows,name){const lines=rows.map(r=>r.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(','));const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([lines.join('\\n')],{type:'text/csv'}));a.download=name;a.click();}
function sortable(table,state,render){table.querySelectorAll('th[data-k]').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.k;state.dir=state.key===k&&state.dir==='desc'?'asc':'desc';state.key=k;table.querySelectorAll('th').forEach(h=>h.removeAttribute('data-dir'));th.dataset.dir=state.dir;render();}));}
function sortRows(rows,state){const k=state.key;if(!k)return rows;const m=state.dir==='asc'?1:-1;return rows.slice().sort((a,b)=>{const x=a[k],y=b[k];if(typeof x==='number'&&typeof y==='number')return (x-y)*m;return String(x??'').localeCompare(String(y??''))*m;});}

// Donors
const dState={key:'total',dir:'desc'};let dView=[];
function donorName(d,legal){if(d.anon&&!legal)return '<td class="name">'+esc(d.display)+' '+pill('anon','gold')+'</td>';return '<td class="name">'+esc(d.name)+(d.anon?' '+pill('anon','gold'):'')+(d.display!==d.name&&!d.anon?'<div class="dim" style="font-weight:400;font-size:12px">shown as '+esc(d.display)+'</div>':'')+'</td>';}
function renderDonors(){const q=$('#donor-q').value.trim().toLowerCase();const f=$('#donor-f').value;const legal=$('#donor-legal').checked;const notes=$('#donor-notes').checked;
 dView=R.donors.filter(d=>{if(f==='pledge'&&!d.pledged)return false;if(f==='online'&&!d.paid)return false;if(f==='anon'&&!d.anon)return false;if(f==='prospect'&&!d.prospect)return false;if(f==='sponsor'&&!d.sponsor)return false;if(f==='ticket'&&!d.ticket)return false;if(f==='repeat'&&d.rel!=='repeat')return false;if(f==='new'&&d.rel!=='new')return false;if(f==='major'&&d.largest<R.event.major_gift_threshold_cents)return false;
  if(!q)return true;const hay=[legal||!d.anon?d.name:'',d.display,d.email,d.city,d.table,d.sponsor,d.prospect&&d.prospect.name,notes?d.notes:''].join(' ').toLowerCase();return hay.includes(q);});
 const rows=sortRows(dView,dState);$('#donor-count').textContent=rows.length+' of '+R.donors.length+' · '+usd0(rows.reduce((s,d)=>s+d.total,0));
 $('#donor-table tbody').innerHTML=rows.map(d=>{const ctx=[];const ident=legal||!d.anon;if(ident&&d.prospect)ctx.push(pill('ask '+usd0(d.prospect.ask||0),'navy'));if(ident&&d.sponsor)ctx.push(pill('sponsor','gold'));if(ident&&d.ticket)ctx.push(pill('ticket'));if(ident&&d.table)ctx.push(pill('table '+d.table.split(':')[0]));if(d.restriction)ctx.push(pill(d.restriction,'green'));if(d.sources.includes('online')&&d.city)ctx.push(pill(d.city));if(d.largest>=R.event.major_gift_threshold_cents)ctx.push(pill('major','orange'));
  const hist=d.bloomerang?('<span class="num">'+usd0(d.bloomerang.lifetime)+'</span> lifetime · '+d.bloomerang.count+' gifts<br><span class="dim">last '+esc(d.bloomerang.last)+' '+usd0(d.bloomerang.lastAmount)+(d.bloomerang.gala?' · gala '+usd0(d.bloomerang.gala):'')+'</span>'):(d.rel==='repeat'?pill('repeat','green'):'<span class="dim">'+(d.prospect&&d.prospect.before?'gave '+usd0(d.prospect.before)+' earlier in 2026':'')+'</span>');
  return '<tr>'+donorName(d,legal)+'<td class="r num"><b>'+usd(d.total)+'</b></td><td class="r num">'+d.count+'</td><td class="r num">'+(d.pledged?usd(d.pledged):'')+'</td><td class="r num">'+(d.paid?usd(d.paid):'')+'</td><td class="num dim">'+esc(d.firstLabel)+'</td><td>'+ctx.join('')+(notes&&d.notes?'<div class="dim" style="font-size:12px;margin-top:3px">'+esc(d.notes)+'</div>':'')+'</td><td>'+hist+'</td></tr>';}).join('');}
['#donor-q','#donor-f','#donor-legal','#donor-notes'].forEach(s=>$(s).addEventListener('input',renderDonors));sortable($('#donor-table'),dState,renderDonors);renderDonors();
$('#donor-csv').addEventListener('click',()=>{const legal=$('#donor-legal').checked;csv([['Donor','Display name','Anonymous','Total','Gifts','Pledged','Online','First gift','Email','City','Prospect ask','Sponsor','Table','Relationship']].concat(sortRows(dView,dState).map(d=>[legal||!d.anon?d.name:d.display,d.display,d.anon?'yes':'',d.total/100,d.count,d.pledged/100,d.paid/100,d.firstLabel,d.email,d.city,d.prospect?d.prospect.ask/100:'',d.sponsor,d.table,d.rel])),'donors.csv');});

// Gifts
const gState={key:'t',dir:'asc'};let gView=[];
function renderGifts(){const q=$('#gift-q').value.trim().toLowerCase();const f=$('#gift-f').value;const legal=$('#donor-legal').checked;
 gView=R.gifts.filter(g=>{if(f==='active'&&g.status!=='active')return false;if(f==='voided'&&g.status!=='voided')return false;if(f==='pledge'&&g.method!=='pledge')return false;if(f==='online'&&g.source!=='online')return false;if(f==='amended'&&!g.amended)return false;if(f==='anon'&&!g.anon)return false;if(f==='notes'&&!g.notes)return false;if(!q)return true;return [g.donor,g.display,g.by,g.notes,g.email,g.city,g.table,g.seated].join(' ').toLowerCase().includes(q);});
 const rows=sortRows(gView,gState);$('#gift-count').textContent=rows.length+' entries · '+usd0(rows.filter(g=>g.status==='active').reduce((s,g)=>s+g.amount,0))+' active';
 $('#gift-table tbody').innerHTML=rows.map(g=>{const flags=[];if(g.status==='voided')flags.push(pill('deleted','red'));if(g.amended)flags.push(pill('was '+usd0(g.original),'orange'));if(g.anon)flags.push(pill('anon','gold'));if(g.recurring)flags.push(pill('monthly','green'));if(g.restriction==='Zakat')flags.push(pill('zakat','green'));if(g.prospect)flags.push(pill('prospect','navy'));if(g.seated)flags.push(pill('table '+g.seated.split(':')[0]));
  return '<tr'+(g.status==='voided'?' style="opacity:.6"':'')+'><td class="num dim">'+esc(g.time)+'</td><td class="name">'+esc(g.anon&&!legal?g.display:g.donor)+'</td><td class="r num"><b>'+usd(g.amount)+'</b></td><td>'+esc(g.method)+'</td><td>'+esc(g.source)+'</td><td>'+esc(g.by)+'</td><td>'+flags.join('')+'</td><td class="dim" style="font-size:12px">'+esc(g.notes)+'</td></tr>';}).join('');}
['#gift-q','#gift-f'].forEach(s=>$(s).addEventListener('input',renderGifts));$('#donor-legal').addEventListener('input',renderGifts);sortable($('#gift-table'),gState,renderGifts);renderGifts();
$('#gift-csv').addEventListener('click',()=>csv([['Time','Donor','Display','Anonymous','Amount','Method','Source','Recorded by','Status','Corrected from','Note','Restriction','Recurring','City']].concat(sortRows(gView,gState).map(g=>[g.time,g.donor,g.display,g.anon?'yes':'',g.amount/100,g.method,g.source,g.by,g.status,g.amended?g.original/100:'',g.notes,g.restriction,g.recurring?'monthly':'',g.city])),'gifts.csv'));

// Prospects
const pState={key:'ask',dir:'desc'};
function renderProspects(){const rows=sortRows(R.prospects.map(p=>({...p,delta:p.ask&&p.actual!==null?p.actual-p.ask:null})),pState);
 $('#prospect-table tbody').innerHTML=rows.map(p=>{const st=p.actual===null?pill('no gift recorded','red'):p.ask&&p.actual<p.ask?pill('below ask','orange'):p.ask?pill('met ask','green'):pill('gave','green');
  return '<tr><td class="name">'+esc(p.name)+(p.matched&&p.matched!==p.name?'<div class="dim" style="font-weight:400;font-size:12px">matched: '+esc(p.matched)+'</div>':'')+'</td><td class="r num">'+(p.before?usd0(p.before):'')+'</td><td class="r num">'+(p.ask?usd0(p.ask):'')+'</td><td class="r num">'+(p.assumed?usd0(p.assumed):'')+'</td><td class="r num">'+(p.actual!==null?'<b>'+usd0(p.actual)+'</b>'+(p.anon?' '+pill('anon','gold'):''):'')+'</td><td class="r num" style="color:'+(p.delta===null?'inherit':p.delta<0?'var(--red)':'var(--green)')+'">'+(p.delta!==null?(p.delta>0?'+':'')+usd0(p.delta):'')+'</td><td>'+st+'</td><td class="dim" style="font-size:12px">'+esc(p.notes)+'</td></tr>';}).join('');}
sortable($('#prospect-table'),pState,renderProspects);renderProspects();
$('#table-table tbody').innerHTML=R.tables.map(t=>'<tr><td class="num">'+esc(t.number)+'</td><td class="name">'+esc(t.host)+'<div class="dim" style="font-weight:400;font-size:12px">'+esc(t.donors.join(', '))+'</div></td><td class="r num">'+t.count+'</td><td class="r num"><b>'+usd0(t.raised)+'</b></td></tr>').join('');
$('#sponsor-table tbody').innerHTML=R.sponsors.filter(s=>s.gave!==null).sort((a,b)=>b.gave-a.gave).map(s=>'<tr><td class="name">'+esc(s.org)+'<div class="dim" style="font-weight:400;font-size:12px">'+esc(s.donor)+'</div></td><td>'+esc(s.tier)+'</td><td class="r num">'+usd0(s.cost)+'</td><td class="r num"><b>'+usd0(s.gave)+'</b></td></tr>').join('')||'<tr><td colspan="4" class="dim">No sponsor matched an appeal gift by name.</td></tr>';

// Follow-up
$('#pledge-table tbody').innerHTML=R.donors.filter(d=>d.pledged).sort((a,b)=>b.pledged-a.pledged).map(d=>'<tr><td class="name">'+esc(d.anon?d.display+' (anonymous)':d.name)+'</td><td class="r num"><b>'+usd0(d.pledged)+'</b></td><td>'+esc([...new Set(R.gifts.filter(g=>g.status==='active'&&g.method==='pledge'&&(g.donor===d.name)).map(g=>g.by))].join(', '))+'</td><td class="dim">'+esc(d.table)+'</td></tr>').join('');
$('#missing-table tbody').innerHTML=R.stats.prospects_missing.sort((a,b)=>b.ask-a.ask).map(p=>'<tr><td class="name">'+esc(p.name)+'</td><td class="r num"><b>'+usd0(p.ask)+'</b></td><td class="dim" style="font-size:12px">'+esc(p.notes)+'</td></tr>').join('');
$('#declined-table tbody').innerHTML=R.declined.map(t=>'<tr><td class="num dim">'+esc(t.time)+'</td><td class="name">'+esc(t.name)+'<div class="dim" style="font-weight:400;font-size:12px">'+esc(t.email)+'</div></td><td class="r num">'+usd(t.amount)+'</td><td class="dim">'+esc(t.payment)+'</td></tr>').join('')||'<tr><td colspan="4" class="dim">No declined attempts.</td></tr>';
$('#ticket-table tbody').innerHTML=R.tickets_no_gift.map(t=>'<tr><td class="name">'+esc(t.name)+'</td><td class="dim">'+esc(t.email)+'</td><td class="r num">'+t.tickets+'</td><td class="dim" style="font-size:12px">'+esc(t.items)+'</td></tr>').join('');
if(document.getElementById('bloom-table'))$('#bloom-table tbody').innerHTML=R.donors.filter(d=>d.bloomerang).map(d=>{const b=d.bloomerang;return '<tr><td class="name">'+esc(d.anon?d.display:d.name)+'</td><td class="r num"><b>'+usd0(d.total)+'</b></td><td class="r num">'+usd0(b.lifetime)+'</td><td class="r num">'+b.count+'</td><td class="num">'+esc(b.first)+'</td><td class="num">'+esc(b.last)+' · '+usd0(b.lastAmount)+'</td><td class="r num">'+(b.gala?usd0(b.gala):'')+'</td><td class="num dim">'+esc(b.years.join(', '))+'</td></tr>';}).join('');

// Charts (inline SVG)
const svg=(w,h,inner)=>'<svg class="chart" viewBox="0 0 '+w+' '+h+'" width="'+w+'" height="'+h+'" style="aspect-ratio:'+w+'/'+h+'" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="goldfade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C59B27" stop-opacity=".35"/><stop offset="1" stop-color="#C59B27" stop-opacity="0"/></linearGradient></defs>'+inner+'</svg>';
(function timeline(){const T=R.stats.timeline;if(!T.length)return;const W=1040,H=300,L=64,Rm=84,top=18,bot=44;const iw=W-L-Rm,ih=H-top-bot;const maxC=Math.max(1,...T.map(b=>b.count));const maxCum=Math.max(1,...T.map(b=>b.cumulative));const bw=iw/T.length;
 let out='';for(let i=0;i<=4;i++){const y=top+ih-ih*i/4;out+='<line class="axis" x1="'+L+'" x2="'+(W-Rm)+'" y1="'+y+'" y2="'+y+'"/><text x="'+(L-8)+'" y="'+(y+4)+'" text-anchor="end">'+Math.round(maxC*i/4)+'</text><text x="'+(W-Rm+8)+'" y="'+(y+4)+'">'+usd0(maxCum*i/4).replace(/,\\d{3}$/,'k').replace(/,\\d{3}k$/,'M')+'</text>';}
 T.forEach((b,i)=>{const h=ih*b.count/maxC;out+='<rect class="bar" x="'+(L+i*bw+1)+'" y="'+(top+ih-h)+'" width="'+Math.max(1,bw-2)+'" height="'+h+'"><title>'+esc(b.label)+': '+b.count+' gifts, '+usd0(b.cents)+'</title></rect>';if(i%Math.ceil(T.length/12)===0)out+='<text x="'+(L+i*bw+bw/2)+'" y="'+(H-bot+16)+'" text-anchor="middle">'+esc(b.label)+'</text>';});
 const pts=T.map((b,i)=>[L+i*bw+bw/2,top+ih-ih*b.cumulative/maxCum]);out+='<path class="area" d="M'+pts[0][0]+','+(top+ih)+' '+pts.map(p=>'L'+p[0]+','+p[1]).join(' ')+' L'+pts[pts.length-1][0]+','+(top+ih)+'Z"/><path class="line" d="M'+pts.map(p=>p[0]+','+p[1]).join(' L')+'"/>';
 R.milestones.filter(m=>m.reached_at).forEach(m=>{const y=top+ih-ih*m.cents/maxCum;if(y<top||y>top+ih)return;out+='<line x1="'+L+'" x2="'+(W-Rm)+'" y1="'+y+'" y2="'+y+'" stroke="#C59B27" stroke-dasharray="3 4" stroke-width="1"/><text class="lbl" x="'+(L+6)+'" y="'+(y-4)+'">'+esc(m.label.toUpperCase())+'</text>';});
 out+='<text class="lbl" x="'+L+'" y="'+(H-6)+'">GIFTS PER 15 MIN</text><text class="lbl" x="'+(W-Rm)+'" y="'+(H-6)+'" text-anchor="end">RUNNING TOTAL</text>';$('#chart-timeline').innerHTML=svg(W,H,out);})();
(function bands(){const B=R.stats.bands;const W=500,rowH=30,L=150,H=B.length*rowH+30;const max=Math.max(1,...B.map(b=>b.cents));let out='';B.forEach((b,i)=>{const y=10+i*rowH;const w=(W-L-110)*b.cents/max;out+='<text x="'+(L-8)+'" y="'+(y+19)+'" text-anchor="end">'+esc(b.label)+'</text><rect class="bar gold" x="'+L+'" y="'+(y+4)+'" width="'+w+'" height="'+(rowH-10)+'"/><text x="'+(L+w+6)+'" y="'+(y+19)+'">'+usd0(b.cents)+' · '+b.count+'</text>';});$('#chart-bands').innerHTML=svg(W,H,out);})();
(function mix(){const S=R.stats;const parts=[['Ballroom pledges',S.pledge_cents,'#1E2A4A'],['Online cards',S.online_cents,'#C59B27'],['Other paid in room',S.manual_paid_cents,'#7C9AC0']].filter(p=>p[1]>0);const total=parts.reduce((s,p)=>s+p[1],0);let x=0,out='';parts.forEach(p=>{const w=480*p[1]/total;out+='<rect x="'+x+'" y="10" width="'+w+'" height="34" fill="'+p[2]+'"/>';if(w>70)out+='<text x="'+(x+8)+'" y="32" fill="#fff" style="fill:#fff">'+Math.round(100*p[1]/total)+'%</text>';x+=w;});let y=70;parts.forEach(p=>{out+='<rect x="0" y="'+(y-10)+'" width="10" height="10" fill="'+p[2]+'"/><text x="16" y="'+y+'">'+esc(p[0])+' · '+usd0(p[1])+'</text>';y+=18;});const z=S.zakat_cents,g=S.general_cents;if(z+g){out+='<text class="lbl" x="0" y="'+(y+12)+'">ONLINE RESTRICTION</text>';const zw=480*z/(z+g);out+='<rect x="0" y="'+(y+20)+'" width="'+zw+'" height="22" fill="#2F6B3A"/><rect x="'+zw+'" y="'+(y+20)+'" width="'+(480-zw)+'" height="22" fill="#D8D3C8"/><text x="0" y="'+(y+58)+'">Zakat '+usd0(z)+' ('+Math.round(100*z/(z+g))+'%) · General '+usd0(g)+'</text>';y+=70;}$('#chart-mix').innerHTML=svg(480,y+4,out);})();
(function pareto(){const D=R.donors.map(d=>d.total);const total=D.reduce((s,v)=>s+v,0);if(!total)return;const W=480,H=170,L=40,top=10,ih=120;let cum=0;const pts=D.map((v,i)=>{cum+=v;return [L+(W-L-10)*(i+1)/D.length,top+ih-ih*cum/total];});let out='<line class="axis" x1="'+L+'" x2="'+(W-10)+'" y1="'+(top+ih)+'" y2="'+(top+ih)+'"/>';[0.5,0.8,1].forEach(f=>{const y=top+ih-ih*f;out+='<line class="axis" x1="'+L+'" x2="'+(W-10)+'" y1="'+y+'" y2="'+y+'" stroke-dasharray="2 4"/><text x="'+(L-6)+'" y="'+(y+4)+'" text-anchor="end">'+Math.round(f*100)+'%</text>';});out+='<path class="line" d="M'+L+','+(top+ih)+' L'+pts.map(p=>p[0]+','+p[1]).join(' L')+'"/>';let n50=D.findIndex((v,i)=>D.slice(0,i+1).reduce((s,x)=>s+x,0)>=total/2)+1;out+='<text class="lbl" x="'+L+'" y="'+(H-8)+'">'+n50+' OF '+D.length+' HOUSEHOLDS GAVE HALF THE TOTAL</text>';$('#chart-pareto').innerHTML=svg(W,H,out);})();
})();
</script>
</body></html>`;
}
