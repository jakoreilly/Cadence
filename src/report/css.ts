// Styles for the generated report. Kept as one string constant so the output
// stays a single self-contained file with no stylesheet to fetch.
export const CSS = `
/* Dark is the default because the report is usually read on a projector in a
   dim room. Light exists because it is also printed and pasted into decks, and
   a dark page prints as a black rectangle or as nothing.

   GOTCHA: the toggle sets data-theme on <html> and that must WIN over the
   media query, so the media query is guarded with :not([data-theme]) - a bare
   @media block would re-darken a page the reader explicitly set to light on a
   machine whose OS is in dark mode, and the toggle would look broken. */
:root {
  --bg:#0b0f19; --panel:#141b2b; --panel-2:#1a2334; --ink:#e9eef8; --sub:#93a0ba;
  --line:#243049; --accent:#5b9bff; --accent-dim:rgba(91,155,255,.14);
  --good:#2fd08a; --watch:#e2b53f; --poor:#ff6b5c; --unknown:#7b88a1;
  --good-dim:rgba(47,208,138,.14); --watch-dim:rgba(226,181,63,.14);
  --poor-dim:rgba(255,107,92,.14); --unknown-dim:rgba(123,136,161,.14);
  --shadow:0 1px 2px rgba(0,0,0,.35);
}
:root[data-theme="light"], :root:not([data-theme]) {
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    --bg:#f5f7fb; --panel:#ffffff; --panel-2:#f0f3f9; --ink:#141b2b; --sub:#5a6683;
    --line:#dde3ee; --accent:#2563eb; --accent-dim:rgba(37,99,235,.10);
    --good:#0f9d63; --watch:#a97609; --poor:#d33a2c; --unknown:#6b7690;
    --good-dim:rgba(15,157,99,.10); --watch-dim:rgba(169,118,9,.10);
    --poor-dim:rgba(211,58,44,.10); --unknown-dim:rgba(107,118,144,.10);
    --shadow:0 1px 2px rgba(20,27,43,.06);
    color-scheme: light;
  }
}
:root[data-theme="light"] {
  --bg:#f5f7fb; --panel:#ffffff; --panel-2:#f0f3f9; --ink:#141b2b; --sub:#5a6683;
  --line:#dde3ee; --accent:#2563eb; --accent-dim:rgba(37,99,235,.10);
  --good:#0f9d63; --watch:#a97609; --poor:#d33a2c; --unknown:#6b7690;
  --good-dim:rgba(15,157,99,.10); --watch-dim:rgba(169,118,9,.10);
  --poor-dim:rgba(211,58,44,.10); --unknown-dim:rgba(107,118,144,.10);
  --shadow:0 1px 2px rgba(20,27,43,.06);
  color-scheme: light;
}
:root[data-theme="dark"] {
  --bg:#0b0f19; --panel:#141b2b; --panel-2:#1a2334; --ink:#e9eef8; --sub:#93a0ba;
  --line:#243049; --accent:#5b9bff; --accent-dim:rgba(91,155,255,.14);
  --good:#2fd08a; --watch:#e2b53f; --poor:#ff6b5c; --unknown:#7b88a1;
  --good-dim:rgba(47,208,138,.14); --watch-dim:rgba(226,181,63,.14);
  --poor-dim:rgba(255,107,92,.14); --unknown-dim:rgba(123,136,161,.14);
  --shadow:0 1px 2px rgba(0,0,0,.35);
  color-scheme: dark;
}
* { box-sizing:border-box; }
html,body { margin:0; padding:0; }
body {
  background:var(--bg); color:var(--ink);
  font:15px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap { max-width:1240px; margin:0 auto; padding:26px 22px 90px; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
h1,h2,h3 { margin:0; font-weight:650; }

/* ---- masthead ---- */
.masthead { display:flex; justify-content:space-between; align-items:flex-end; gap:20px; flex-wrap:wrap; margin-bottom:22px; }
.masthead h1 { font-size:25px; letter-spacing:-.01em; }
.masthead .sub { color:var(--sub); font-size:12.5px; margin-top:5px; }
.stamp { color:var(--sub); font-size:12px; text-align:right; }

/* ---- triage banner ---- */
.triage { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:12px; margin-bottom:22px; }
.triage-card { background:var(--panel); border:1px solid var(--line); border-left-width:3px; border-radius:10px; padding:14px 16px; }
.triage-card.good { border-left-color:var(--good); }
.triage-card.watch { border-left-color:var(--watch); }
.triage-card.poor { border-left-color:var(--poor); }
.triage-card.unknown { border-left-color:var(--unknown); }
.triage-card .who { font-size:15px; font-weight:650; display:flex; align-items:center; gap:8px; }
.triage-card .verdict { font-size:11px; text-transform:uppercase; letter-spacing:.06em; font-weight:700; margin-top:2px; }
.triage-card.good .verdict { color:var(--good); }
.triage-card.watch .verdict { color:var(--watch); }
.triage-card.poor .verdict { color:var(--poor); }
.triage-card.unknown .verdict { color:var(--unknown); }
.triage-card .why { color:var(--sub); font-size:12.5px; margin-top:7px; }

/* ---- KPI tiles ---- */
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin:16px 0; }
.kpi { background:var(--panel-2); border:1px solid var(--line); border-radius:10px; padding:13px 15px; }
.kpi .label { color:var(--sub); font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
.kpi .value { font-size:25px; font-weight:750; margin-top:3px; font-variant-numeric:tabular-nums; }
.kpi .note { color:var(--sub); font-size:11.5px; margin-top:2px; }
.kpi.good .value { color:var(--good); } .kpi.watch .value { color:var(--watch); }
.kpi.poor .value { color:var(--poor); } .kpi.unknown .value { color:var(--unknown); }

/* ---- panels & tabs ---- */
.panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:20px 22px; margin-bottom:18px; }
.panel > h2, .sec > summary > h2 { font-size:17px; display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.panel > .lede, .sec > .expander-body > .lede { color:var(--sub); font-size:13px; max-width:88ch; margin:7px 0 0; }
.tabbar { display:flex; gap:6px; flex-wrap:wrap; border-bottom:1px solid var(--line); margin-bottom:16px; }
.tab { background:none; border:none; border-bottom:2px solid transparent; color:var(--sub); font:inherit;
  font-size:13.5px; font-weight:600; padding:9px 13px; cursor:pointer; border-radius:6px 6px 0 0; }
.tab:hover { color:var(--ink); background:rgba(255,255,255,.03); }
.tab[aria-selected="true"] { color:var(--ink); border-bottom-color:var(--accent); }
.tab .dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-left:6px; vertical-align:middle; }
.dot.good { background:var(--good); } .dot.watch { background:var(--watch); }
.dot.poor { background:var(--poor); } .dot.unknown { background:var(--unknown); }
.tabpanel[hidden] { display:none; }

/* ---- tags ---- */
.tag { font-size:10.5px; font-weight:700; letter-spacing:.05em; padding:2px 7px; border-radius:999px; text-transform:uppercase; }
.tag.sound { background:var(--good-dim); color:var(--good); }
.tag.weak { background:var(--watch-dim); color:var(--watch); }
.tag.unusable { background:var(--poor-dim); color:var(--poor); }
.tag.caveat { background:var(--accent-dim); color:var(--accent); text-transform:none; font-weight:600; }
.prefix { font-family:ui-monospace,Consolas,monospace; font-size:11.5px; background:var(--accent-dim); color:var(--accent); padding:1px 6px; border-radius:4px; }

/* ---- charts ---- */
.chart-box { position:relative; height:280px; margin:14px 0 4px; }
.chart-box.short { height:200px; }
.chart-note { color:var(--sub); font-size:11.5px; margin:0 0 6px; }
noscript .nojs { background:var(--watch-dim); border:1px solid var(--watch); color:var(--ink);
  border-radius:8px; padding:11px 14px; font-size:13px; display:block; margin:12px 0; }

/* ---- tables ---- */
.table-scroll { overflow-x:auto; margin:12px 0; }
table { border-collapse:collapse; width:100%; font-size:13px; }
th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--sub); font-size:11px; font-weight:650; letter-spacing:.03em; text-transform:uppercase;
  position:sticky; top:0; background:var(--panel); z-index:1; }
th.sortable { cursor:pointer; user-select:none; }
th.sortable:hover { color:var(--ink); }
th.sortable::after { content:"  "; color:var(--sub); font-size:9px; }
th.sortable[data-dir="asc"]::after { content:" \\2191"; color:var(--accent); }
th.sortable[data-dir="desc"]::after { content:" \\2193"; color:var(--accent); }
td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
tbody tr:hover { background:rgba(255,255,255,.025); }
tr.clickable { cursor:pointer; }
.muted { color:var(--sub); font-size:11.5px; }
.key-cell { font-family:ui-monospace,Consolas,monospace; font-weight:650; }
td.good { color:var(--good); } td.watch { color:var(--watch); } td.poor { color:var(--poor); font-weight:700; }
td.unknown { color:var(--unknown); }

/* ---- reason chips ---- */
.chip { display:inline-block; font-size:10.5px; font-weight:650; padding:1px 7px; border-radius:999px; margin:1px 3px 1px 0; white-space:nowrap; }
.chip.blocked { background:var(--poor-dim); color:var(--poor); }
.chip.carried { background:var(--watch-dim); color:var(--watch); }
.chip.stale { background:rgba(255,138,92,.15); color:#ff8a5c; }
.chip.unestimated { background:var(--accent-dim); color:var(--accent); }
.chip.unassigned { background:var(--unknown-dim); color:var(--unknown); }

/* ---- health rows ---- */
.health { display:grid; gap:8px; margin:12px 0; }
.health-row { display:grid; grid-template-columns:130px 74px 1fr; gap:12px; align-items:center;
  background:var(--panel-2); border:1px solid var(--line); border-left-width:3px; border-radius:8px; padding:9px 13px; }
.health-row.good { border-left-color:var(--good); } .health-row.watch { border-left-color:var(--watch); }
.health-row.poor { border-left-color:var(--poor); } .health-row.unknown { border-left-color:var(--unknown); }
.health-row .h-label { font-weight:650; font-size:13px; }
.health-row .h-value { font-weight:750; font-variant-numeric:tabular-nums; }
.health-row.good .h-value { color:var(--good); } .health-row.watch .h-value { color:var(--watch); }
.health-row.poor .h-value { color:var(--poor); } .health-row.unknown .h-value { color:var(--unknown); }
.health-row .h-detail { color:var(--sub); font-size:12.5px; }

/* ---- callouts ---- */
.callout { display:flex; gap:17px; align-items:center; background:var(--accent-dim);
  border:1px solid var(--line); border-radius:10px; padding:14px 17px; margin:13px 0; }
.callout.warn { background:var(--poor-dim); border-color:rgba(255,107,92,.3); }
.callout.neutral { background:var(--unknown-dim); }
.callout .big { font-size:27px; font-weight:800; min-width:110px; font-variant-numeric:tabular-nums; }
.callout.warn .big { color:var(--poor); }
.callout .body { color:var(--sub); font-size:13px; }
.callout .body strong { color:var(--ink); }
.footnote { color:var(--sub); font-size:11.5px; max-width:92ch; }

/* ---- modal ---- */
.modal-backdrop { position:fixed; inset:0; background:rgba(4,7,14,.72); display:none;
  align-items:center; justify-content:center; padding:24px; z-index:50; }
.modal-backdrop.open { display:flex; }
.modal { background:var(--panel); border:1px solid var(--line); border-radius:13px;
  max-width:640px; width:100%; max-height:82vh; overflow:auto; padding:22px 25px; }
.modal h3 { font-size:17px; margin-bottom:3px; }
.modal .modal-sub { color:var(--sub); font-size:12.5px; margin-bottom:14px; }
.modal dl { display:grid; grid-template-columns:max-content 1fr; gap:7px 16px; margin:0 0 14px; font-size:13px; }
.modal dt { color:var(--sub); }
.modal dd { margin:0; }
.modal .close { float:right; background:none; border:1px solid var(--line); color:var(--sub);
  border-radius:7px; font:inherit; font-size:12px; padding:4px 11px; cursor:pointer; }
.modal .close:hover { color:var(--ink); border-color:var(--sub); }
.modal .advice { background:var(--panel-2); border-left:3px solid var(--accent);
  border-radius:7px; padding:11px 14px; font-size:13px; color:var(--sub); }
.modal .advice strong { color:var(--ink); }

/* ---- toolbar ---- */
.toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.btn { background:var(--panel-2); border:1px solid var(--line); color:var(--sub); font:inherit;
  font-size:12.5px; font-weight:600; padding:6px 12px; border-radius:7px; cursor:pointer; }
.btn:hover { color:var(--ink); border-color:var(--sub); }
.btn:focus-visible, .tab:focus-visible, .filter input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.btn.copied { color:var(--good); border-color:var(--good); }

/* ---- filter box ---- */
.filter { display:flex; align-items:center; gap:9px; margin:12px 0 0; flex-wrap:wrap; }
.filter input { background:var(--panel-2); border:1px solid var(--line); color:var(--ink);
  font:inherit; font-size:13px; padding:7px 11px; border-radius:7px; min-width:230px; }
.filter input::placeholder { color:var(--sub); }
.filter .count { color:var(--sub); font-size:12px; }
tr[data-filtered] { display:none; }

/* ---- sticky tabs ---- */
.tabbar { position:sticky; top:0; z-index:3; background:var(--panel); padding-top:2px; }

/* ---- churn ---- */
.churn { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin:13px 0; }
.churn-cell { background:var(--panel-2); border:1px solid var(--line); border-radius:9px; padding:11px 13px; }
.churn-cell .n { font-size:22px; font-weight:750; font-variant-numeric:tabular-nums; }
.churn-cell .n.up { color:var(--poor); } .churn-cell .n.down { color:var(--good); }
.churn-cell .l { color:var(--sub); font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
.notyet { background:var(--unknown-dim); border:1px dashed var(--line); border-radius:9px;
  padding:13px 16px; color:var(--sub); font-size:13px; }

/* ---- progress meter ---- */
.meter { height:7px; border-radius:999px; background:var(--panel-2); border:1px solid var(--line);
  overflow:hidden; margin:9px 0 4px; }
.meter > span { display:block; height:100%; background:var(--accent); }
.meter-labels { display:flex; justify-content:space-between; color:var(--sub); font-size:11.5px; }

/* ---- legend ---- */
.legend dl { display:grid; grid-template-columns:max-content 1fr; gap:8px 17px; margin:9px 0 0; }
.legend dd { margin:0; color:var(--sub); font-size:12.5px; max-width:88ch; }
footer { color:var(--sub); font-size:11.5px; text-align:center; margin-top:34px; }


/* ---- hover cards --------------------------------------------------------
   The single most important addition for a reader who does not already know
   the estate. Two mechanisms deliberately coexist: the native title attribute
   (which survives a blocked script, and on the locked-down laptop this report
   targets that is a normal Tuesday) and the styled card below, which can hold
   several lines. client.ts strips the title when it takes over so the two
   never render on top of each other. */
.tip { border-bottom:1px dotted var(--sub); cursor:help; }
.tip:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.term { border-bottom:1px dotted var(--accent); }
.tipcard {
  position:fixed; z-index:80; max-width:420px; display:none;
  background:var(--panel-2); color:var(--ink); border:1px solid var(--line);
  border-left:3px solid var(--accent); border-radius:9px; box-shadow:0 8px 26px rgba(0,0,0,.35);
  padding:10px 13px; font-size:12.5px; line-height:1.5; white-space:pre-line;
}
.tipcard.open { display:block; }
.ticket { border-bottom:1px dotted var(--sub); font-family:ui-monospace,Consolas,monospace; font-weight:650; }
.ticket a { color:var(--accent); }
.tcell { display:flex; flex-direction:column; gap:1px; max-width:46ch; }
.tcell .tsummary { color:var(--sub); font-size:11.5px; font-weight:400; font-family:inherit;
  overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }

/* ---- expandable explainers ---------------------------------------------- */
.expander { margin:14px 0 0; border:1px solid var(--line); border-radius:9px; background:var(--panel-2); }
.expander > summary { cursor:pointer; padding:9px 14px; font-size:12.5px; font-weight:650; color:var(--sub);
  list-style:none; display:flex; align-items:center; gap:8px; }
.expander > summary::-webkit-details-marker { display:none; }
.expander > summary::before { content:"\\203A"; display:inline-block; transition:transform .12s ease; font-size:15px; }
.expander[open] > summary::before { transform:rotate(90deg); }
.expander > summary:hover { color:var(--ink); }
.expander-body { padding:2px 16px 14px; }
dl.explain { display:grid; grid-template-columns:max-content 1fr; gap:7px 16px; margin:0; font-size:12.5px; }
dl.explain dt { color:var(--sub); text-transform:uppercase; font-size:10.5px; letter-spacing:.05em; font-weight:700; padding-top:2px; }
dl.explain dd { margin:0; color:var(--ink); max-width:92ch; }
ol.steps { margin:0; padding-left:20px; font-size:13px; color:var(--ink); }
ol.steps li { margin-bottom:6px; max-width:92ch; }
.swatch { display:inline-block; width:11px; height:11px; border-radius:3px; vertical-align:-1px; margin-right:3px; }
.swatch.good { background:var(--good); } .swatch.watch { background:var(--watch); }
.swatch.poor { background:var(--poor); } .swatch.unknown { background:var(--unknown); }
.orientation { border-left:3px solid var(--accent); }

/* ---- interventions -------------------------------------------------------
   Cards rather than table rows because each one is a paragraph of reasoning,
   not a value, and a table of paragraphs is unreadable. The left border colour
   is the severity, repeated as a text label - colour alone is not a signal for
   a reader who cannot distinguish red from amber. */
.act-panel { border-left:3px solid var(--poor); }
.ivn-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(360px,1fr)); gap:13px; margin-top:14px; }
.ivn { background:var(--panel-2); border:1px solid var(--line); border-left-width:3px; border-radius:10px; padding:14px 16px; }
.ivn.act-now { border-left-color:var(--poor); }
.ivn.this-week { border-left-color:var(--watch); }
.ivn.watch { border-left-color:var(--unknown); }
.ivn header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
.ivn .sev { font-size:10.5px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; padding:2px 8px; border-radius:999px; border-bottom:none; }
.ivn.act-now .sev { background:var(--poor-dim); color:var(--poor); }
.ivn.this-week .sev { background:var(--watch-dim); color:var(--watch); }
.ivn.watch .sev { background:var(--unknown-dim); color:var(--unknown); }
.ivn .team-chip { font-size:11.5px; font-weight:700; background:var(--accent-dim); color:var(--accent); padding:1px 8px; border-radius:999px; }
.ivn .kind { color:var(--sub); font-size:11px; text-transform:uppercase; letter-spacing:.05em; margin-left:auto; }
.ivn h4 { margin:0 0 6px; font-size:14px; font-weight:700; line-height:1.4; }
.ivn .what { margin:0 0 8px; font-size:12.5px; color:var(--sub); }
.ivn .whyact { display:grid; gap:7px; font-size:12.5px; color:var(--sub); }
.ivn .whyact .lbl { display:block; color:var(--sub); font-size:10px; text-transform:uppercase; letter-spacing:.06em; font-weight:700; margin-bottom:1px; }
.ivn .whyact strong { color:var(--ink); font-weight:650; }
.ivn footer { margin-top:10px; padding-top:9px; border-top:1px solid var(--line); font-size:12px; display:flex; gap:7px; flex-wrap:wrap; align-items:center; }
blockquote.evidence { margin:0 0 9px; padding:8px 12px; background:var(--bg); border-left:3px solid var(--watch);
  border-radius:6px; font-size:12.5px; color:var(--ink); font-style:italic; }
blockquote.evidence footer { border:none; margin:5px 0 0; padding:0; color:var(--sub); font-style:normal; font-size:11px; }
.ivn-controls { display:flex; align-items:center; gap:7px; flex-wrap:wrap; margin-top:12px; }
.chip-btn { background:var(--panel-2); border:1px solid var(--line); color:var(--sub); font:inherit;
  font-size:12px; font-weight:650; padding:4px 11px; border-radius:999px; cursor:pointer; }
.chip-btn:hover { color:var(--ink); border-color:var(--sub); }
.chip-btn.on { color:var(--ink); border-color:var(--accent); background:var(--accent-dim); }
.ivn-controls .sep { width:1px; height:18px; background:var(--line); margin:0 4px; }
.ivn[data-hidden] { display:none; }
.btn-link { font-size:11.5px; font-weight:650; }
.good-note { color:var(--good) !important; }
.warn-text { color:var(--poor); font-weight:650; }

/* ---- top-level view rail ---- */
.viewbar { position:sticky; top:0; z-index:5; background:var(--bg); margin:0 0 18px;
  padding:6px 0; border-bottom:1px solid var(--line); }
.viewrail { display:flex; gap:3px; flex-wrap:wrap; background:var(--panel-2); border:1px solid var(--line);
  border-radius:11px; padding:4px; width:max-content; max-width:100%; }
.viewrail .tab { border:none; border-radius:8px; padding:8px 15px; font-size:13.5px; font-weight:650; }
.viewrail .tab:hover { color:var(--ink); background:var(--panel); }
.viewrail .tab[aria-selected="true"] { color:var(--ink); background:var(--panel);
  border-bottom-color:transparent; box-shadow:var(--shadow); }
.viewrail .tab .muted { font-size:11px; opacity:.85; }
.view-hint { color:var(--sub); font-size:12.5px; margin:26px 0 0; padding-top:18px; border-top:1px solid var(--line); }

/* ---- per-team sub navigation ---- */
.team-head { border-left:3px solid var(--accent); }
.team-head > h2 [data-md-team], .team-head > h2 .btn-sm { margin-left:auto; font-size:11.5px; padding:4px 10px; }
.subnav { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:16px 24px;
  margin-top:16px; padding-top:14px; border-top:1px solid var(--line); }
.subnav-group { display:flex; flex-direction:column; gap:3px; min-width:0; }
.subnav-head { font-size:10px; letter-spacing:.09em; text-transform:uppercase; color:var(--sub);
  font-weight:800; margin-bottom:3px; display:flex; align-items:center; gap:6px; }
.subnav-link { display:block; font-size:12px; font-weight:500; color:var(--sub); padding:2px 0; }
.subnav-link:hover { color:var(--ink); text-decoration:none; }

/* ---- the condensed sticky team header ---- */
.team-sticky { position:sticky; top:44px; z-index:4; display:flex; align-items:center; gap:10px; flex-wrap:wrap;
  background:var(--panel); border:1px solid var(--line); border-radius:9px; padding:7px 13px; margin:0 0 16px;
  font-size:12.5px; }
.team-sticky[hidden] { display:none; }
.team-sticky .sticky-kpi { color:var(--sub); font-variant-numeric:tabular-nums; }
.team-sticky .sticky-kpi.poor { color:var(--poor); }
.team-sticky .sticky-top { margin-left:auto; font-size:11px; color:var(--sub); }

/* A section a search-palette or subnav link has just jumped to, briefly. */
.sec-landed { box-shadow:inset 3px 0 0 var(--accent); background:var(--accent-dim);
  transition:background .4s, box-shadow .4s; }

/* ---- the search palette (Ctrl-K) ---- */
.palette-backdrop { position:fixed; inset:0; background:rgba(4,7,14,.62); z-index:90;
  display:flex; align-items:flex-start; justify-content:center; padding:12vh 16px 16px; }
.palette-backdrop[hidden] { display:none; }
.palette { width:min(640px,100%); background:var(--panel); border:1px solid var(--line);
  border-radius:12px; box-shadow:0 24px 60px rgba(0,0,0,.4); overflow:hidden; }
.palette > input { width:100%; box-sizing:border-box; border:none; background:none; color:var(--ink);
  font:inherit; font-size:15px; padding:14px 16px; outline:none; }
.palette > input::placeholder { color:var(--sub); }
.palette-hint { font-size:10.5px; color:var(--sub); padding:6px 16px; border-bottom:1px solid var(--line);
  border-top:1px solid var(--line); }
.palette-results { list-style:none; margin:0; padding:5px; max-height:52vh; overflow-y:auto; }
.palette-results li { display:flex; align-items:baseline; gap:10px; padding:7px 11px; border-radius:7px;
  cursor:pointer; }
.palette-results li.on { background:var(--accent-dim); }
.palette-results .pk { flex:0 0 auto; font-size:9.5px; letter-spacing:.07em; text-transform:uppercase;
  font-weight:800; color:var(--sub); min-width:52px; }
.palette-results .pl { flex:0 0 auto; font-family:ui-monospace,Consolas,monospace; color:var(--ink); }
.palette-results .pd { color:var(--sub); font-size:11.5px; overflow:hidden; white-space:nowrap;
  text-overflow:ellipsis; }
.palette-results .pnone { display:block; color:var(--sub); font-size:12px; cursor:default; line-height:1.6; }

.tab .badge { display:inline-block; min-width:17px; text-align:center; margin-left:6px; font-size:10.5px;
  font-weight:800; background:var(--poor); color:#fff; border-radius:999px; padding:0 5px; }
.triage-card .acts { margin-top:7px; font-size:11.5px; font-weight:700; color:var(--poor); }
.triage-card .board-link { margin-top:6px; font-size:11.5px; }

/* ---- epics ---- */
.bar { display:inline-block; width:64px; height:7px; border-radius:999px; background:var(--panel-2);
  border:1px solid var(--line); overflow:hidden; vertical-align:middle; }
.bar > span { display:block; height:100%; background:var(--accent); }
.bar-label { font-size:11px; color:var(--sub); margin-left:6px; }
td.people { font-size:12px; color:var(--sub); max-width:22ch; }
tr.done-col td { opacity:.75; }

/* ---- repos & pages ---- */
.repos { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
.repo { display:flex; align-items:center; gap:8px; background:var(--panel-2); border:1px solid var(--line);
  border-radius:8px; padding:5px 11px; font-size:12px; }
.repo .path { font-family:ui-monospace,Consolas,monospace; }
.repo .n { color:var(--sub); font-variant-numeric:tabular-nums; }
ul.pages { list-style:none; margin:10px 0; padding:0; display:grid; gap:10px; }
ul.pages li { background:var(--panel-2); border:1px solid var(--line); border-radius:9px; padding:10px 13px; }
ul.pages .excerpt { color:var(--sub); font-size:12px; margin-top:4px; max-width:92ch; }
dl.orient { display:grid; grid-template-columns:max-content 1fr; gap:11px 18px; margin:14px 0 0; font-size:13px; }
dl.orient dt { color:var(--sub); text-transform:uppercase; font-size:10.5px; letter-spacing:.05em; font-weight:700; padding-top:3px; }
dl.orient dd { margin:0; max-width:92ch; }
dl.orient dd .muted { display:block; margin-top:3px; }
dl.orient dd.prov { color:var(--sub); font-size:12px; }
.goal { margin-bottom:4px; }
dl.glossary { grid-template-columns:max-content 1fr; }
ul.caveats { margin:10px 0; padding-left:20px; font-size:12.5px; color:var(--sub); }
ul.caveats li { margin-bottom:6px; max-width:96ch; }
ul.caveats strong { color:var(--ink); }
.modal .modal-desc { color:var(--sub); font-size:13px; margin:0 0 12px; }
.meter > i { display:block; height:100%; background:var(--good); margin-top:-100%; opacity:.9; }

/* ---- extra reason chips ---- */
.chip.blocked-by { background:rgba(255,107,92,.13); color:var(--poor); }
.chip.commented-blocked { background:rgba(226,181,63,.18); color:var(--watch); }
.chip.overdue { background:rgba(255,107,92,.2); color:var(--poor); font-weight:750; }
.tag.new { background:var(--accent-dim); color:var(--accent); }

/* ---- the estate mapping diagram -------------------------------------------
   Board -> GitLab group -> Confluence space, drawn as three columns of nodes
   with the join written between them: this is a structure, not a quantity.
   An "absent" node is drawn dashed rather than omitted - a missing GitLab
   group is the reason a whole column of this report is empty for that team,
   and a row that simply stops after the board hides the gap it is meant to
   expose. */
.mapgraph { margin:18px 0 6px; }
.map-row { display:grid; grid-template-columns:1fr 34px 1fr 34px 1fr; align-items:stretch;
  gap:0; margin-top:14px; }
.map-node { border:1px solid var(--line); border-radius:4px; padding:10px 12px;
  background:var(--panel-2); min-width:0; font-size:12.5px; }
.map-node.absent { border-style:dashed; background:none; }
.map-kind { font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--sub); margin-bottom:4px; }
.map-meta { margin-top:6px; font-size:11px; color:var(--sub); }
.map-join { display:flex; align-items:center; justify-content:center; }
.map-wire { display:block; width:100%; height:1px; background:var(--line); }
.map-why { margin:6px 0 2px; }
.map-why .prov { color:var(--sub); font-size:12px; margin:0; max-width:110ch; }
td.chips-cell { max-width:26ch; }
td.chips-cell .chip { margin:0 4px 3px 0; }
a.chip.team-chip { text-decoration:none; }

/* ---- the estate org chart ------------------------------------------------
   Server-rendered SVG, so it is complete with scripting blocked and it prints.
   A box in an org chart is not decoration around a value, it IS the object the
   wire connects to, so nodes are the one place on this page that keep a real
   filled surface with a border and a radius. */
.orgchart { margin:22px 0 8px; overflow-x:auto; padding-bottom:6px; }
.orgchart svg { display:block; }
.org-wire { fill:none; stroke:var(--line); stroke-width:1.25; }
.org-box { fill:var(--panel-2); stroke:var(--line); stroke-width:1; }
.org-estate .org-box { fill:var(--panel); stroke:var(--line); }
.org-label { fill:var(--ink); font-size:13.5px; font-weight:500; letter-spacing:-.008em; }
.org-estate .org-label { font-size:14.5px; font-weight:400; }
.org-meta, .org-acts { fill:var(--sub); font-size:11px; font-family:ui-monospace,Consolas,monospace; }
.org-acts { fill:var(--poor); }
.org-bar { fill:transparent; }
.tone-good .org-bar { fill:var(--good); }
.tone-watch .org-bar { fill:var(--watch); }
.tone-poor .org-bar { fill:var(--poor); }
.tone-unknown .org-bar { fill:var(--unknown); }
/* A board box is a link into that board's tab, so it has to LOOK like one on
   hover. The border is what moves, not the fill: a fill change on a box this
   size flashes, and there can be a dozen under a moving pointer. */
.org-link { cursor:pointer; }
.org-link .org-box { transition:stroke .12s ease, fill .12s ease; }
.org-link:hover .org-box { stroke:var(--accent); fill:var(--panel); }
.org-link:focus-visible { outline:none; }
.org-link:focus-visible .org-box { stroke:var(--accent); stroke-width:2; }

@media (max-width:720px) {
  .map-row { grid-template-columns:1fr; }
  .map-join { height:14px; }
  .map-wire { width:1px; height:100%; }
  .callout { flex-direction:column; align-items:flex-start; }
  dl.explain, dl.orient { grid-template-columns:1fr; }
  .ivn-grid { grid-template-columns:1fr; }
  .tcell { max-width:none; }
  .health-row { grid-template-columns:1fr; gap:3px; }
  .legend dl,.modal dl { grid-template-columns:1fr; }
}
/* A SECTION's disclosure, not an explainer's. Same mechanism, deliberately
   different presentation: the summary here IS the section heading, so it keeps
   heading type and ink and takes a larger chevron on the baseline. */
.panel > details.sec { border-top:none; margin:0; }
.sec > summary {
  font-family:inherit; font-size:inherit; color:var(--ink);
  padding:0; gap:10px; align-items:center;
}
.sec > summary::before { font-size:17px; color:var(--sub); align-self:center; }
.sec > summary:hover::before { color:var(--ink); }
.sec > summary > h2 { flex:1 1 auto; }
.sec > .expander-body { padding:0; }
/* A closed section is a quiet row, not a missing one. */
.sec:not([open]) > summary { padding:2px 0; }
/* The one line a closed section shows beside its heading, so it is summarised
   rather than hidden. Reuses .muted's ink and size; only the spacing is new. */
.sec-gist { margin-left:auto; white-space:nowrap; }
/* A filter over a section's OWN open/closed state, never a second collapse
   mechanism. Hiding the whole <section> (not just its body) means a hidden
   section also drops out of the subnav's scroll target list with no extra
   work. */
section[data-lens-hidden] { display:none; }

@media print {
  /* A reader who filtered to "only what needs me" and then prints must get the
     whole document, or the printout is silently partial with no way to tell
     from the paper. The print BUTTON also clears the lens in client.ts; this
     covers Ctrl-P, which never runs that handler. */
  section[data-lens-hidden] { display:block !important; }
  /* GOTCHA: overriding only body leaves every panel painted from --panel, which
     is near-black, so the page prints as black rectangles with invisible text
     and burns a toner cartridge. The whole token set has to flip, not the body. */
  :root, :root[data-theme="dark"], :root[data-theme="light"] {
    --bg:#fff; --panel:#fff; --panel-2:#fafbfd; --ink:#111; --sub:#555; --line:#ccc;
    --accent:#1a4fbf; --accent-dim:#eef2fb; --good:#0a7a4c; --watch:#8a5f00; --poor:#b3241a;
    --unknown:#666; --good-dim:#eef7f2; --watch-dim:#fbf5e8; --poor-dim:#fbeeed; --unknown-dim:#f2f2f4;
    --shadow:none; color-scheme: light;
  }
  .panel,.triage-card,.kpi,.health-row,.churn-cell { break-inside:avoid; }
  .map-row { break-inside:avoid; }
  .tabpanel[hidden] { display:block !important; }
  .tabbar,.viewbar,.view-hint,.toolbar,.filter,.modal-backdrop,.subnav,.ivn-controls,.tipcard { display:none !important; }
  .palette-backdrop,.team-sticky,[data-md-team] { display:none !important; }
  .sec-landed { box-shadow:none !important; background:none !important; }
  /* The ask chips and prompt buttons are actions, and paper has no actions.
     The banner itself STAYS - a printed copy should still tell the reader the
     file carries a briefing digest - but it prints flat rather than as a
     gradient panel, which would come out as a grey smear. */
  .ask-chip,.ask-grid,.briefing-copied { display:none !important; }
  .briefing { background:none !important; border:1px solid #ccc; }
  /* The stale-data banner is the one thing on this page that MUST survive being
     printed and handed round: a paper copy that has dropped "these numbers came
     from old code" is worse than no notice at all. */
  .stale { background:none !important; border:2px solid #b3241a !important; }
  .stale details.expander { display:none !important; }
  .bar { background:#888 !important; }
  /* A collapsed explainer prints as a single line of summary text, which reads
     as a missing section rather than as a closed one. Everything opens on
     paper, where there is nothing to collapse for. */
  details.expander > .expander-body { display:block !important; }
  .ivn[data-hidden] { display:block !important; }
  tr[data-filtered] { display:table-row !important; }
}

/* --- the stale-data banner ---------------------------------------------------
   Louder than the hand-off banner and placed above it, because the reader this
   protects is not confused - they are confidently reading a panel that says
   "not collected" as "there is nothing here today". Not collapsible, and it
   deliberately keeps its border and its red rule when printed. */
.stale {
  background:var(--poor-dim); border:1px solid var(--poor); border-left:4px solid var(--poor);
  border-radius:10px; padding:16px 18px; margin:18px 0;
}
.stale-head h2 { margin:6px 0 6px; font-size:18px; }
.stale-badge {
  display:inline-block; background:var(--poor); color:#fff; font-size:11px; font-weight:700;
  letter-spacing:.04em; text-transform:uppercase; padding:3px 8px; border-radius:999px;
}
.stale-list { margin:10px 0 0; color:var(--sub); font-size:13px; }
.stale-list > li { margin:6px 0; }
.stale-list ul.plain { margin:4px 0 0 14px; }
.stale-list ul.plain li { margin:2px 0; }
.stale-fix { margin:12px 0 4px; font-size:13px; font-weight:600; }
.stale-fix code { font-size:12.5px; }

/* --- the hand-off banner -----------------------------------------------------
   Deliberately the loudest thing on the page after the masthead. A reader who
   does not know the file carries a briefing digest will read the tables and
   conclude the tool cannot answer "so what". */
.briefing {
  background:linear-gradient(180deg, var(--accent-dim), transparent 70%);
  border:1px solid var(--accent); border-radius:10px; padding:16px 18px; margin:18px 0;
  box-shadow:var(--shadow);
}
.briefing-head h2 { margin:6px 0 6px; font-size:18px; }
.briefing-badge {
  display:inline-block; background:var(--accent); color:#fff; font-size:11px; font-weight:700;
  letter-spacing:.04em; text-transform:uppercase; padding:3px 8px; border-radius:999px;
}
.briefing-how { margin:10px 0 14px 18px; padding:0; color:var(--sub); font-size:13px; }
.briefing-how li { margin:3px 0; }
.ask-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:8px; }
.ask-btn {
  text-align:left; background:var(--panel-2); border:1px solid var(--line); border-radius:8px;
  padding:9px 11px; cursor:pointer; color:var(--ink); font:inherit; transition:border-color .12s, transform .12s;
}
.ask-btn:hover, .ask-btn:focus-visible { border-color:var(--accent); transform:translateY(-1px); outline:none; }
.ask-btn-label { display:block; font-weight:650; font-size:13px; }
.ask-btn-blurb { display:block; color:var(--sub); font-size:11.5px; margin-top:2px; line-height:1.35; }
.briefing-copied { min-height:18px; margin:9px 0 0; color:var(--good); font-size:12.5px; font-weight:600; }
.rules li { margin:3px 0; color:var(--sub); font-size:12px; }

/* The per-panel question. A chip in the heading rather than a floating button:
   it has to be discoverable without competing with the numbers. */
.ask-chip {
  display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; cursor:pointer;
  background:transparent; border:1px dashed var(--line); color:var(--sub);
  font-size:11px; font-weight:600; vertical-align:middle; font-family:inherit;
}
.ask-chip:hover, .ask-chip:focus-visible { border-color:var(--accent); color:var(--accent); border-style:solid; outline:none; }

/* --- categorical mixes -------------------------------------------------------- */
.mix-block { margin:14px 0; }
.mix-block h4 { margin:0 0 6px; font-size:13px; color:var(--sub); text-transform:uppercase; letter-spacing:.05em; }
.bar-cell { min-width:130px; white-space:nowrap; }
.bar {
  display:inline-block; height:8px; border-radius:4px; background:var(--accent);
  vertical-align:middle; min-width:2px; max-width:70%;
}
.bar-alert { background:var(--watch); }
.bar-label { margin-left:7px; color:var(--sub); font-size:12px; vertical-align:middle; }

/* A row the reader should look at first. Border rather than a fill, so it still
   reads on paper and for a reader who cannot distinguish the accent colours. */
tr.row-alert > td { background:var(--watch-dim); }
tr.row-alert > td:first-child { box-shadow:inset 3px 0 0 var(--watch); }

/* A row whose figures could not be computed at all - every entry in that column
   predates the first snapshot, so its medians are blank rather than zero. Dimmed
   rather than hidden: the COUNT is real and the column is really there, and
   dropping the row would make the open-work totals disagree with the board
   panel two sections up. Opacity only, so it still prints and still reads for
   anyone who cannot distinguish the accent colours. */
tr.row-muted > td { opacity:.62; }

/* --- quoted comments ----------------------------------------------------------
   Verbatim and truncated at collection time. Rendered as a quote rather than as
   a table cell because it is somebody's words and should not look like data. */
tr.quote-row > td { padding-top:0; border-top:none; }
blockquote.comment {
  margin:0 0 8px; padding:7px 11px; border-left:3px solid var(--line);
  background:var(--panel-2); border-radius:0 6px 6px 0; color:var(--ink);
  font-size:12.5px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere;
}
.comment-meta { display:block; color:var(--sub); font-size:11px; margin-bottom:3px; font-weight:600; }

ul.plain { list-style:none; margin:6px 0; padding:0; }
ul.plain li { margin:3px 0; }

/* ---- chart palette ---------------------------------------------------------
   NEW tokens, not a restyle: nothing existing references them, and Cadence's
   older chart specs keep their baked hex (the client-side resolver passes a
   plain colour straight through). client.ts reads these off the live stylesheet
   immediately before it constructs each chart, so a mark repaints on the theme
   toggle and prints in ink rather than in neon.

   The eight categorical inks are the SAME HUES across dark, light and print,
   dropped in lightness for each surface so "amber is the second series" holds
   on the projector and on the printout. The flow ramp is ONE hue, light to
   dark, in board order - a sequence, not a set of kinds. */
:root, :root[data-theme="dark"] {
  --c-1:#6e8bef; --c-2:#e0a33e; --c-3:#35b98f; --c-4:#e0796f;
  --c-5:#a98be8; --c-6:#4fb6d8; --c-7:#d07fb0; --c-8:#9ab55a;
  --c-fill-hi:rgba(110,139,239,.26); --c-fill-lo:rgba(110,139,239,.01);
  --c-flow-1:#39426b; --c-flow-2:#454f81; --c-flow-3:#525d97; --c-flow-4:#5f6cad;
  --c-flow-5:#6f7cc0; --c-flow-6:#8290d0; --c-flow-7:#96a3de; --c-flow-8:#adb8e9;
}
:root[data-theme="light"] {
  --c-1:#3f52a8; --c-2:#a76a12; --c-3:#10796a; --c-4:#b4453a;
  --c-5:#6b4ca8; --c-6:#16708f; --c-7:#a33c79; --c-8:#5e7420;
  --c-fill-hi:rgba(63,82,168,.20); --c-fill-lo:rgba(63,82,168,.01);
  --c-flow-1:#ccd4ee; --c-flow-2:#b4bee5; --c-flow-3:#9aa7db; --c-flow-4:#8090cf;
  --c-flow-5:#6777c0; --c-flow-6:#5060a6; --c-flow-7:#3b4a85; --c-flow-8:#2a3363;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    --c-1:#3f52a8; --c-2:#a76a12; --c-3:#10796a; --c-4:#b4453a;
    --c-5:#6b4ca8; --c-6:#16708f; --c-7:#a33c79; --c-8:#5e7420;
    --c-fill-hi:rgba(63,82,168,.20); --c-fill-lo:rgba(63,82,168,.01);
    --c-flow-1:#ccd4ee; --c-flow-2:#b4bee5; --c-flow-3:#9aa7db; --c-flow-4:#8090cf;
    --c-flow-5:#6777c0; --c-flow-6:#5060a6; --c-flow-7:#3b4a85; --c-flow-8:#2a3363;
  }
}
@media print {
  :root, :root[data-theme="dark"], :root[data-theme="light"] {
    --c-1:#31428d; --c-2:#8f5a0e; --c-3:#0c6659; --c-4:#9c3a30;
    --c-5:#5a3f8f; --c-6:#125f79; --c-7:#8c3367; --c-8:#4f621b;
    --c-fill-hi:rgba(49,66,141,.16); --c-fill-lo:rgba(49,66,141,.01);
    --c-flow-1:#ccd4ee; --c-flow-2:#b4bee5; --c-flow-3:#9aa7db; --c-flow-4:#8090cf;
    --c-flow-5:#6777c0; --c-flow-6:#5060a6; --c-flow-7:#3b4a85; --c-flow-8:#2a3363;
  }
}

/* ---- sparkline, and the small shared render primitives ------------------- */
.spark { display:inline-block; line-height:0; }
.spark svg { display:block; overflow:visible; }
.spark-line { stroke:var(--sub); stroke-width:1.3; stroke-linejoin:round; stroke-linecap:round; }
.spark-dot { fill:var(--accent); }
.spark-none { color:var(--sub); font-size:11px; }
td.spark-cell { width:96px; padding-top:9px; }
.mono { font-variant-numeric:tabular-nums; font-feature-settings:"tnum" 1; }
.btn-sm { font-size:10.5px; padding:3px 8px; margin-left:10px; vertical-align:middle; }
.tone-good .org-bar { fill:var(--good); }
.tone-watch .org-bar { fill:var(--watch); }
.tone-poor .org-bar { fill:var(--poor); }
.tone-unknown .org-bar { fill:var(--unknown); }
@media print {
  .spark-line { stroke:#555 !important; }
  td.spark-cell { display:none; }
}

/* ---- what changed since the previous collected day ---------------------- */
.chg-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; margin:14px 0 4px; }
.chg { display:flex; flex-direction:column; gap:0; }
.chg-strip { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:11.5px; margin-bottom:5px; }
.chg-badge { font-family:ui-monospace,Consolas,monospace; font-size:10.5px; font-weight:400; letter-spacing:0;
  padding:1px 0 2px; border-radius:0; background:none; border-bottom:1px solid currentColor; text-transform:lowercase; }
.chg-badge.new { color:var(--accent); }
.chg-badge.escalated { color:var(--poor); }
.chg-badge.eased { color:var(--watch); }
.chg-badge.cleared { color:var(--good); }
/* A cleared finding describes YESTERDAY - it is not on today's board - so it is
   visibly quieter than the rest rather than sitting among them as current. */
.chg-cleared .ivn { opacity:.72; }
@media print { .chg-cleared .ivn { opacity:1; } }

@media (prefers-reduced-motion: reduce) {
  * { transition:none !important; animation:none !important; }
}
`;
