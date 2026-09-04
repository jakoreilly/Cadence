// Client-side behaviour for the generated report, emitted as an inline
// <script>. Progressive enhancement ONLY: tabs, table sorting, ticket modals
// and Chart.js rendering. Every number this touches is already present as text
// in the server-rendered HTML, so with scripting blocked the page degrades to
// readable tables rather than to blank panels.
//
// No number is ever computed here. See the header of report/index.ts.
export const CLIENT_JS = String.raw`
(function () {
  "use strict";

  // ---- theme -------------------------------------------------------------
  // Persisted per reader, not per report: the same person regenerates this file
  // every morning and should not have to re-pick a theme daily. localStorage can
  // throw outright on a file:// page under some browser privacy settings, so
  // every access is guarded - a report that fails to open because the theme
  // could not be remembered would be a poor trade.
  var THEME_KEY = "cadence-theme";
  function storedTheme() {
    try { return window.localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
    var btn = document.getElementById("theme-toggle");
    if (btn) {
      var dark = t ? t === "dark" : !window.matchMedia("(prefers-color-scheme: light)").matches;
      btn.textContent = dark ? "Light theme" : "Dark theme";
      btn.setAttribute("aria-label", dark ? "Switch to the light theme" : "Switch to the dark theme");
    }
    // Chart.js bakes its axis and legend colours in at construction, so a theme
    // change after a chart is drawn leaves grey-on-white text unreadable. Drawn
    // charts are torn down and redrawn rather than restyled in place.
    redrawAll();
  }
  var themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var current = document.documentElement.getAttribute("data-theme");
      var next = current === "dark" ? "light" : current === "light" ? "dark"
        : (window.matchMedia("(prefers-color-scheme: light)").matches ? "dark" : "light");
      try { window.localStorage.setItem(THEME_KEY, next); } catch (e) { /* not fatal */ }
      applyTheme(next);
    });
  }

  // ---- tabs -------------------------------------------------------------
  // GOTCHA: the selected tab lives in the URL hash so a manager can send
  // "...report.html#team=fs" and land a colleague on the same board. It is NOT a
  // plain #id anchor: that would make the browser scroll to the panel and fight
  // the tab logic for control of the same fragment.
  //
  // There are now TWO nested levels of them - the view rail (across the estate /
  // teams / people / epics / data / mapping) and, inside the teams view, the
  // per-board bar - so the hash is a set of key=value pairs rather than one
  // value: "#view=teams&team=fs". Each group declares its own key in data-tabs,
  // and a bare legacy "#team=fs" still parses to exactly the same thing, because
  // every link ever sent out of an older report was of that form.
  var tabGroups = [];

  function parseHash() {
    var out = {};
    (window.location.hash || "").replace(/^#/, "").split("&").forEach(function (part) {
      var eq = part.indexOf("=");
      if (eq > 0) out[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
    });
    return out;
  }

  // A group's own value for a panel id, with both the shared "panel-" prefix and
  // the group's key stripped: "panel-view-teams" in the "view" group is "teams",
  // and "panel-fs" in the "team" group is "fs". Without the second strip the
  // view tabs would write "#view=view-teams", which is what the reader would
  // then be copying into a message.
  function valueOf(g, id) {
    var v = String(id).replace(/^panel-/, "");
    return v.indexOf(g.key + "-") === 0 ? v.slice(g.key.length + 1) : v;
  }
  function idOf(g, value) {
    return "panel-" + value;
  }

  // The section a link asked for, so "#view=teams&team=fs&sec=ageing" sends a
  // colleague to the exact panel rather than to the top of a tab with twenty of
  // them. Held here rather than derived from scroll position: guessing which
  // section a reader is "on" rewrites the URL under them as they scroll.
  //
  // Cleared whenever a TAB is chosen, because a section id is only meaningful
  // inside the team it belongs to.
  var currentSec = null;

  function writeHash() {
    var parts = [];
    tabGroups.forEach(function (g) {
      if (g.current) parts.push(g.key + "=" + encodeURIComponent(valueOf(g, g.current)));
    });
    if (currentSec) parts.push("sec=" + encodeURIComponent(currentSec));
    if (!parts.length) return;
    try { history.replaceState(null, "", "#" + parts.join("&")); }
    catch (e) { /* file:// refuses replaceState in some browsers - not fatal */ }
  }

  document.querySelectorAll("[data-tabs]").forEach(function (group) {
    var tabs = Array.prototype.slice.call(group.querySelectorAll("[role=tab]"));
    var g = {
      // Defaults to "team" so a bar that predates the second level needs no
      // attribute value.
      key: group.getAttribute("data-tabs") || "team",
      group: group,
      tabs: tabs,
      // Read out of the MARKUP rather than assumed null: the view rail ships
      // with its first tab already selected so the landing view paints without
      // waiting for this script.
      current: (function () {
        for (var i = 0; i < tabs.length; i++) {
          if (tabs[i].getAttribute("aria-selected") === "true") return tabs[i].getAttribute("data-target");
        }
        return null;
      })(),
    };

    // A nested group's own panel may be hidden - clicking a team tab from a
    // deep link, or from a triage card, has to open the Teams view as well or
    // the reader is sent to a panel inside a hidden one and sees nothing move.
    function revealAncestor() {
      var host = group.closest ? group.closest(".tabpanel") : null;
      if (!host || !host.id) return;
      tabGroups.forEach(function (other) {
        if (other === g) return;
        for (var i = 0; i < other.tabs.length; i++) {
          if (other.tabs[i].getAttribute("data-target") === host.id) { other.select(host.id, false); return; }
        }
      });
    }

    g.select = function (id, pushHash) {
      var found = false;
      tabs.forEach(function (t) {
        var on = t.getAttribute("data-target") === id;
        if (on) found = true;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        var p = document.getElementById(t.getAttribute("data-target"));
        if (p) p.hidden = !on;
      });
      if (found) {
        g.current = id;
        revealAncestor();
        if (pushHash) writeHash();
      }
      // Charts inside a hidden panel lay out at zero width, so they are drawn on
      // first reveal rather than up front.
      drawPending();
      return found;
    };

    tabGroups.push(g);
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { currentSec = null; g.select(t.getAttribute("data-target"), true); });
      t.addEventListener("keydown", function (e) {
        var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var n = tabs[(i + d + tabs.length) % tabs.length];
        n.focus(); g.select(n.getAttribute("data-target"), true);
      });
    });
  });

  function selectFromHash() {
    var params = parseHash();
    var hit = false;
    tabGroups.forEach(function (g) {
      var v = params[g.key];
      if (v === undefined) return;
      // Both spellings are accepted: the value this group writes ("teams") and
      // the raw panel suffix ("view-teams"), so a hand-edited or older link is
      // not silently ignored.
      if (g.select(idOf(g, v), false) || g.select(idOf(g, g.key + "-" + v), false)) hit = true;
    });
    // The section, after the tabs: the panel has to be visible before there is
    // anything to scroll to, and a scrollIntoView on a hidden element silently
    // does nothing.
    if (params.sec !== undefined && params.team !== undefined) {
      currentSec = params.sec;
      revealSection(params.team, params.sec);
    }
    return hit;
  }

  // Opens the section a link named and puts it under the reader's eye. Also
  // opens its explainer if the section shipped collapsed - a reader sent
  // directly to a panel that starts closed arrives at a one-line summary and
  // concludes the panel is empty.
  function revealSection(team, sec) {
    var el = document.getElementById("sec-" + team + "-" + sec);
    if (!el) return false;
    el.querySelectorAll("details.expander").forEach(function (d) { d.open = true; });
    // After the tab reveal has laid out, or the target's position is measured
    // against a panel that was display:none a moment ago.
    window.setTimeout(function () {
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      el.classList.add("sec-landed");
      window.setTimeout(function () { el.classList.remove("sec-landed"); }, 2200);
    }, 30);
    return true;
  }

  // The grouped subnav. Its hrefs are the shareable form - a full
  // view/team/sec hash - so copying one out of the page gives a working link,
  // and the click handler does the reveal without waiting for a hashchange.
  document.querySelectorAll("[data-sec-link]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      var id = a.getAttribute("data-sec-link") || "";
      var m = /^sec-(.+)-([^-]+)$/.exec(id);
      if (!m) return;
      e.preventDefault();
      currentSec = m[2];
      revealSection(m[1], m[2]);
      writeHash();
    });
  });

  window.addEventListener("hashchange", function () { selectFromHash(); });

  // ---- ticket filter -----------------------------------------------------
  // Filters ROWS, never the underlying figures. The "showing N of M" count is
  // recomputed from the DOM so it cannot disagree with what is on screen, and no
  // number in any panel is touched - a filtered table is a reading aid, not a
  // different measurement.
  document.querySelectorAll("[data-filter-for]").forEach(function (box) {
    var input = box.querySelector("input");
    var count = box.querySelector(".count");
    var table = document.getElementById(box.getAttribute("data-filter-for"));
    if (!input || !table) return;
    var body = table.tBodies[0];
    if (!body) return;
    var total = body.rows.length;
    function apply() {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      Array.prototype.slice.call(body.rows).forEach(function (r) {
        var hit = !q || r.textContent.toLowerCase().indexOf(q) !== -1;
        if (hit) { r.removeAttribute("data-filtered"); shown++; }
        else r.setAttribute("data-filtered", "");
      });
      if (count) count.textContent = q ? "showing " + shown + " of " + total : total + " rows";
    }
    input.addEventListener("input", apply);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { input.value = ""; apply(); }
    });
    apply();
  });

  // ---- copy summary ------------------------------------------------------
  // Every figure in the copied text is read back out of the rendered DOM rather
  // than recomputed, so the clipboard can never disagree with the page.
  document.querySelectorAll("[data-copy-from]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var src = document.getElementById(btn.getAttribute("data-copy-from"));
      if (!src) return;
      var lines = [];
      Array.prototype.slice.call(src.querySelectorAll("[data-summary-line]")).forEach(function (el) {
        var text = el.textContent.replace(/\s+/g, " ").trim();
        if (text) lines.push(text);
      });
      var text = lines.join("\n");
      function done() {
        var was = btn.getAttribute("data-label") || btn.textContent;
        btn.setAttribute("data-label", was);
        btn.textContent = "Copied";
        btn.classList.add("copied");
        setTimeout(function () { btn.textContent = was; btn.classList.remove("copied"); }, 1600);
      }
      // GOTCHA: navigator.clipboard is undefined on a file:// page in Firefox and
      // rejects outside a user-gesture chain elsewhere, so the deprecated
      // execCommand path is the FALLBACK rather than the legacy branch - on the
      // locked-down laptop this report targets it is often the only one that runs.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, done); });
      } else legacyCopy(text, done);
    });
  });
  function legacyCopy(text, done) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { /* nothing else to try */ }
    document.body.removeChild(ta);
  }

  // ---- the hand-off layer ------------------------------------------------
  // Copies a ready-made prompt to the clipboard. The prompt TEXT is read out of
  // the embedded #to-brief block rather than rebuilt here, for the same reason
  // the summary copier reads the DOM: two sources for one string is one source
  // too many, and the one that drifts is always the copy nobody is looking at.
  var briefing = null;
  try {
    var briefEl = document.getElementById("to-brief");
    if (briefEl) briefing = JSON.parse(briefEl.textContent);
  } catch (e) { briefing = null; }

  function flash(msg) {
    var out = document.getElementById("briefing-copied");
    if (!out) return;
    out.textContent = msg;
    setTimeout(function () { if (out.textContent === msg) out.textContent = ""; }, 4000);
  }

  function copyText(text, okMsg) {
    function done() { flash(okMsg); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, done); });
    } else legacyCopy(text, done);
  }

  document.querySelectorAll(".ask-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (!briefing || !briefing.prompts) {
        flash("Prompt data is not embedded in this file.");
        return;
      }
      var id = btn.getAttribute("data-prompt-id");
      var found = null;
      briefing.prompts.forEach(function (p) { if (p.id === id) found = p; });
      if (!found) { flash("That prompt is not in this file."); return; }
      copyText(found.text, "Copied “" + found.label + "”. Paste it into Claude alongside this HTML file.");
    });
  });

  // Per-panel questions. The chip is BUILT here rather than rendered server-side
  // because it does nothing at all without a clipboard: a button printed into
  // the HTML that silently fails when scripting is blocked is worse than no
  // button, and this report is opened with scripting blocked routinely.
  document.querySelectorAll("[data-ask]").forEach(function (sec) {
    var heading = sec.querySelector("h2");
    if (!heading) return;
    var chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ask-chip";
    chip.textContent = "Ask Claude";
    chip.title = "Copy a question about this panel, scoped to this panel only so it costs very little to answer.";
    chip.addEventListener("click", function () {
      var q = sec.getAttribute("data-ask");
      var preamble =
        "Read the JSON in the <script id=\"to-brief\"> block of the attached Cadence report " +
        "(it is small - do not read #to-data unless this question needs per-ticket detail). Then ";
      copyText(preamble + q, "Question copied. Paste it into Claude with this HTML file attached.");
    });
    heading.appendChild(chip);
  });

  // ---- sortable tables ---------------------------------------------------
  document.querySelectorAll("table[data-sortable]").forEach(function (table) {
    var head = table.tHead && table.tHead.rows[0];
    if (!head) return;
    Array.prototype.slice.call(head.cells).forEach(function (th, idx) {
      if (th.hasAttribute("data-nosort")) return;
      th.classList.add("sortable");
      th.addEventListener("click", function () {
        var dir = th.getAttribute("data-dir") === "desc" ? "asc" : "desc";
        Array.prototype.slice.call(head.cells).forEach(function (o) { o.removeAttribute("data-dir"); });
        th.setAttribute("data-dir", dir);
        var body = table.tBodies[0];
        var rows = Array.prototype.slice.call(body.rows);
        rows.sort(function (a, b) {
          var av = cell(a, idx), bv = cell(b, idx);
          var an = parseFloat(av), bn = parseFloat(bv);
          var both = !isNaN(an) && !isNaN(bn);
          var r = both ? an - bn : String(av).localeCompare(String(bv));
          return dir === "asc" ? r : -r;
        });
        rows.forEach(function (r) { body.appendChild(r); });
      });
    });
    function cell(row, i) {
      var c = row.cells[i];
      if (!c) return "";
      // data-sort lets a cell sort on its underlying number while displaying
      // something friendlier ("3 sprints", "blocked").
      return c.getAttribute("data-sort") !== null ? c.getAttribute("data-sort") : c.textContent.trim();
    }
  });

  // ---- ticket modal ------------------------------------------------------
  var backdrop = document.getElementById("modal-backdrop");
  var modal = document.getElementById("modal-body");
  var lastFocus = null;

  function openModal(html) {
    if (!backdrop || !modal) return;
    lastFocus = document.activeElement;
    modal.innerHTML = html;
    backdrop.classList.add("open");
    var c = modal.querySelector(".close");
    if (c) c.focus();
  }
  function closeModal() {
    if (!backdrop) return;
    backdrop.classList.remove("open");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  if (backdrop) {
    backdrop.addEventListener("click", function (e) { if (e.target === backdrop) closeModal(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeModal(); return; }
      // A dialog with aria-modal that does not actually trap focus is worse than
      // no dialog: a keyboard reader tabs straight out of it into a page the
      // screen reader still reports as inert, and there is no way back.
      if (e.key !== "Tab" || !backdrop.classList.contains("open")) return;
      var focusable = modal.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest ? e.target.closest("[data-detail]") : null;
    if (!t) return;
    if (e.target.closest("a")) return;
    openModal(decodeURIComponent(t.getAttribute("data-detail")));
  });
  document.addEventListener("click", function (e) {
    if (e.target.classList && e.target.classList.contains("close")) closeModal();
  });

  // ---- charts ------------------------------------------------------------
  var SPECS = window.__TO_CHARTS__ || {};
  var drawn = {};
  function drawPending() {
    Object.keys(SPECS).forEach(function (id) {
      if (drawn[id]) return;
      var el = document.getElementById(id);
      if (!el || !el.offsetParent) return;   // still hidden - draw on reveal
      if (typeof Chart === "undefined") return;
      var ctx2 = el.getContext("2d");
      // resolveColours DEEP-CLONES the spec, turning "var(--x)" token names and
      // "gradient:var(--x)" markers into live values read off the stylesheet. It
      // passes a plain colour string straight through, so Cadence's older specs
      // that still carry baked hex are unaffected, and SPECS[id] itself stays
      // pristine for the theme-rebuild redraw.
      var s = resolveColours(SPECS[id], ctx2, el);
      installTooltips(s);
      applyChartTheme();
      // The handle is kept so a theme change can destroy and rebuild it. Chart.js
      // reads Chart.defaults ONCE, at construction, so restyling in place leaves
      // grey axis labels on a white page.
      drawn[id] = new Chart(ctx2, s);
    });
  }

  function redrawAll() {
    if (typeof Chart === "undefined") return;
    Object.keys(drawn).forEach(function (id) {
      var chart = drawn[id];
      if (chart && chart.destroy) chart.destroy();
      delete drawn[id];
    });
    drawPending();
  }

  // Read the palette off the live stylesheet rather than repeating the hex
  // values here: two copies of a colour is two colours the first time one of
  // them is edited.
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }
  function applyChartTheme() {
    if (typeof Chart === "undefined") return;
    Chart.defaults.color = cssVar("--sub", "#93a0ba");
    Chart.defaults.borderColor = cssVar("--line", "#243049");
  }

  // Chart.js bakes dataset colours in at construction, so a spec that carries a
  // token NAME rather than a hex value can repaint with the theme toggle and the
  // print stylesheet. resolveColours walks a spec immediately before the
  // new Chart(...) call and swaps the names for live values off the stylesheet.
  //
  // GOTCHA: use SINGLE backslashes in this regex. Doubling them - correct in an
  // ordinary template literal - would emit a pattern matching a literal
  // backslash, which matches no colour string at all, and every var() would
  // survive to Chart.js and it would draw its own default palette with no error.
  var VAR_RE = /^var\(\s*(--[\w-]+)\s*\)$/;
  // "gradient:var(--x)" (from gradientFill() in charts.ts) asks for a vertical
  // wash from that colour at the top of the plot to --c-fill-lo at the axis. It
  // cannot just be a colour: a CanvasGradient needs the pixel height of the plot
  // area, which does not exist until the chart is laid out.
  var GRAD_RE = /^gradient:(.+)$/;

  /** Builds the real vertical wash, top of the canvas to the axis.
   *
   *  GOTCHA, and it cost a blank panel upstream: the obvious implementation is a
   *  SCRIPTABLE OPTION, a function Chart.js calls per draw with the live
   *  chartArea. Chart.js then tries to ANIMATE that property, cannot classify a
   *  function as a colour, and throws out of its own animator on the first tick
   *  - the panel is simply an empty rectangle and the exception escapes into
   *  requestAnimationFrame where nothing is watching. So the gradient is a REAL
   *  CanvasGradient built here from the canvas's own height before construction,
   *  and colour animation is switched off on any chart that carries one. */
  function makeGradient(ctx, canvas, top) {
    var h = canvas.clientHeight || canvas.height || 200;
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top);
    g.addColorStop(1, cssVar("--c-fill-lo", "rgba(91,155,255,.02)"));
    return g;
  }

  function resolveColours(spec, ctx, canvas) {
    var sawGradient = false;
    var out = walk(spec);
    if (sawGradient) {
      out.options = out.options || {};
      out.options.animations = out.options.animations || {};
      out.options.animations.colors = false;
    }
    return out;
    function walk(v) {
      if (typeof v === "string") {
        var gm = GRAD_RE.exec(v);
        if (gm) {
          var inner = VAR_RE.exec(gm[1]);
          sawGradient = true;
          return makeGradient(ctx, canvas, inner ? cssVar(inner[1], "#5b9bff") : gm[1]);
        }
        var m = VAR_RE.exec(v);
        return m ? cssVar(m[1], "#5b9bff") : v;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        var o = {};
        Object.keys(v).forEach(function (k) { o[k] = walk(v[k]); });
        return o;
      }
      return v;
    }
  }

  // Chart.js tooltip callbacks are functions, and every spec arrives here as
  // JSON - JSON.stringify drops function values without an error. So the spec
  // carries the DATA in _meta and the callbacks are rebuilt here. See the
  // GOTCHA on ChartSpec in report/index.ts.
  function installTooltips(s) {
    var meta = s._meta;
    if (!meta) return;
    s.options = s.options || {};
    s.options.plugins = s.options.plugins || {};
    var tip = s.options.plugins.tooltip = s.options.plugins.tooltip || {};
    tip.callbacks = tip.callbacks || {};
    function at(list, items) {
      var i = items && items[0] ? items[0].dataIndex : 0;
      return list[i] || "";
    }
    if (meta.tooltipTitles) {
      tip.callbacks.title = function (items) { return at(meta.tooltipTitles, items); };
    }
    if (meta.tooltipAfterBody) {
      tip.callbacks.afterBody = function (items) { return at(meta.tooltipAfterBody, items); };
    }
    // A scatter's marks are not one-per-category, so dataIndex identifies a
    // point WITHIN a dataset rather than a shared index across them. The label
    // therefore has to be looked up by both, which tooltipTitles cannot do.
    if (meta.pointLabels) {
      tip.callbacks.label = function (item) {
        var byDataset = meta.pointLabels[item.datasetIndex];
        if (byDataset && byDataset[item.dataIndex]) return byDataset[item.dataIndex];
        // A reference line has no pointLabels row of its own; falling through to
        // the dataset's name is what makes "p90 12.4d" show on hover rather than
        // an empty box.
        return item.dataset && item.dataset.label ? item.dataset.label : "";
      };
    }
    // Numeric x values that stand for dates. The map is sparse on purpose - a
    // label on every day of a three-month span is a smear - so a tick with no
    // entry gets an empty string rather than its raw number, which would
    // otherwise print "37" under a mark that means the 6th of August.
    if (meta.xTickLabels) {
      s.options.scales = s.options.scales || {};
      s.options.scales.x = s.options.scales.x || {};
      s.options.scales.x.ticks = s.options.scales.x.ticks || {};
      s.options.scales.x.ticks.callback = function (value) {
        var key = String(value);
        return Object.prototype.hasOwnProperty.call(meta.xTickLabels, key) ? meta.xTickLabels[key] : "";
      };
      // Without this Chart.js picks its own tick values off the linear scale -
      // 0, 20, 40 - and almost none of them exist in the sparse map, so every
      // label comes out blank. autoSkip off with a step of 1 asks for a tick at
      // every integer and lets the callback decide which ones say anything.
      s.options.scales.x.ticks.autoSkip = false;
      s.options.scales.x.ticks.stepSize = 1;
    }
  }

  if (typeof Chart !== "undefined") {
    Chart.defaults.font.family = "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.plugins.legend.labels.boxWidth = 11;
    Chart.defaults.plugins.legend.labels.boxHeight = 11;
    Chart.defaults.maintainAspectRatio = false;
    applyChartTheme();
  }


  // ---- hover cards -------------------------------------------------------
  // Every ticket key, person and piece of jargon carries data-tip AND the
  // native title attribute. The title is what a reader gets when this script is
  // blocked - on the locked-down laptop this report targets, that is a normal
  // Tuesday, and a tooltip that exists only in JavaScript is a tooltip that does
  // not exist for the audience most likely to need it.
  //
  // GOTCHA: the two must not both fire. Leaving the title in place gives a
  // native grey box drifting under the styled card a beat later, on every hover,
  // across the whole page. So the title is MOVED to data-title the moment this
  // code takes over - moved rather than deleted, so nothing is lost if a future
  // change wants it back.
  var tipcard = document.getElementById("tipcard");
  var tipTimer = null;

  function placeTip(el) {
    if (!tipcard) return;
    var text = el.getAttribute("data-tip");
    if (!text) return;
    tipcard.textContent = text;
    tipcard.classList.add("open");
    tipcard.setAttribute("aria-hidden", "false");
    // Measured AFTER the text is in, because the card's height depends on it.
    var r = el.getBoundingClientRect();
    var c = tipcard.getBoundingClientRect();
    var margin = 8;
    var left = Math.min(Math.max(margin, r.left), window.innerWidth - c.width - margin);
    // Below the element by default, above it when there is no room - a card that
    // runs off the bottom of the viewport is a card nobody reads.
    var top = r.bottom + margin;
    if (top + c.height > window.innerHeight - margin) top = Math.max(margin, r.top - c.height - margin);
    tipcard.style.left = left + "px";
    tipcard.style.top = top + "px";
  }
  function hideTip() {
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    if (!tipcard) return;
    tipcard.classList.remove("open");
    tipcard.setAttribute("aria-hidden", "true");
  }
  if (tipcard) {
    document.querySelectorAll("[data-tip][title]").forEach(function (el) {
      el.setAttribute("data-title", el.getAttribute("title"));
      el.removeAttribute("title");
    });
    document.addEventListener("mouseover", function (e) {
      var el = e.target.closest ? e.target.closest("[data-tip]") : null;
      if (!el) return;
      if (tipTimer) clearTimeout(tipTimer);
      tipTimer = setTimeout(function () { placeTip(el); }, 90);
    });
    document.addEventListener("mouseout", function (e) {
      var el = e.target.closest ? e.target.closest("[data-tip]") : null;
      if (el) hideTip();
    });
    document.addEventListener("focusin", function (e) {
      var el = e.target.closest ? e.target.closest("[data-tip]") : null;
      if (el) placeTip(el);
    });
    document.addEventListener("focusout", hideTip);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") hideTip(); });
    window.addEventListener("scroll", hideTip, true);
  }

  // ---- expand / collapse every explainer ---------------------------------
  var expandBtn = document.getElementById("expand-all");
  if (expandBtn) {
    expandBtn.addEventListener("click", function () {
      var all = Array.prototype.slice.call(document.querySelectorAll("details.expander"));
      // "Expand all" when any is closed, "collapse all" when every one is open.
      // A single toggle that flips on its own state leaves the reader guessing
      // what the button will do; the label always says what happens next.
      var anyClosed = all.some(function (d) { return !d.open; });
      all.forEach(function (d) { d.open = anyClosed; });
      expandBtn.textContent = anyClosed ? "Collapse all" : "Expand all";
    });
  }

  // ---- the "only what needs me" lens ----------------------------------------
  // A LENS over the sections, not a second collapse mechanism: it sets
  // data-lens-hidden, which CSS hides. The section's own open/closed state is
  // untouched, so turning the lens off restores exactly what the reader had.
  //
  // Reads data-needs (set server-side in sectionHtml from the SAME needsReader
  // resolver that decided the section's default open state) rather than
  // details.sec[open], deliberately: reading [open] would make "Expand all"
  // defeat the lens by opening every section first, which reads as a broken
  // toggle. data-needs is a static fact about the section and Expand all never
  // touches it.
  document.querySelectorAll("[data-lens-for]").forEach(function (bar) {
    var team = bar.getAttribute("data-lens-for");
    var panel = document.getElementById("panel-" + team);
    if (!panel) return;
    var empty = panel.querySelector("[data-lens-empty-for]");
    bar.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-lens]") : null;
      if (!btn) return;
      var only = btn.getAttribute("data-lens") === "needs";
      bar.querySelectorAll("[data-lens]").forEach(function (b) {
        b.classList.toggle("on", b === btn);
      });
      var shown = 0;
      panel.querySelectorAll("section[data-section]").forEach(function (sec) {
        var d = sec.querySelector("details.sec");
        var needed = d && d.getAttribute("data-needs") === "true";
        if (only && !needed) {
          sec.setAttribute("data-lens-hidden", "");
        } else {
          sec.removeAttribute("data-lens-hidden");
          shown++;
        }
      });
      if (empty) empty.hidden = !(only && shown === 0);
    });
  });

  var printBtn = document.getElementById("print-btn");
  // The print button must clear the lens before printing: a reader who filtered
  // and then prints must get the whole document, or the printout is silently
  // partial with no way to tell from the paper. The CSS force-show rule covers
  // the Ctrl-P path, which never runs this handler.
  if (printBtn) {
    document.querySelectorAll('[data-lens-for]').forEach(function (bar) {
      var everything = bar.querySelector('[data-lens="all"]');
      if (everything) printBtn.addEventListener("click", function () { everything.click(); });
    });
  }
  if (printBtn) {
    printBtn.addEventListener("click", function () {
      // Everything opens before the print dialog: a collapsed explainer prints
      // as one line of summary text, which reads as a section that is missing
      // rather than one that is closed.
      document.querySelectorAll("details.expander").forEach(function (d) { d.open = true; });
      window.print();
    });
  }

  // ---- intervention filters ----------------------------------------------
  // Filters CARDS, never figures. The counts on the buttons are rendered
  // server-side from the full set and are not recomputed here, so a filtered
  // view can never disagree with the page about how many there are.
  document.querySelectorAll("[data-ivn-for]").forEach(function (bar) {
    var grid = document.getElementById(bar.getAttribute("data-ivn-for"));
    if (!grid) return;
    var sev = "", team = "";
    function apply() {
      Array.prototype.slice.call(grid.children).forEach(function (card) {
        var ok = (!sev || card.getAttribute("data-severity") === sev) &&
                 (!team || card.getAttribute("data-team") === team);
        if (ok) card.removeAttribute("data-hidden");
        else card.setAttribute("data-hidden", "");
      });
    }
    bar.querySelectorAll("[data-filter-severity]").forEach(function (b) {
      b.addEventListener("click", function () {
        sev = b.getAttribute("data-filter-severity");
        bar.querySelectorAll("[data-filter-severity]").forEach(function (o) { o.classList.remove("on"); });
        b.classList.add("on");
        apply();
      });
    });
    bar.querySelectorAll("[data-filter-team]").forEach(function (b) {
      b.addEventListener("click", function () {
        team = b.getAttribute("data-filter-team");
        bar.querySelectorAll("[data-filter-team]").forEach(function (o) { o.classList.remove("on"); });
        b.classList.add("on");
        apply();
      });
    });
  });

  // ---- team chips inside intervention cards ------------------------------
  // A card in the estate-wide feed names its team; clicking that should open the
  // team's tab rather than jumping to a raw id the tab logic then fights over.
  document.querySelectorAll(".ivn .team-chip").forEach(function (a) {
    a.addEventListener("click", function (e) {
      var href = a.getAttribute("href") || "";
      if (href.indexOf("#team=") !== 0) return;
      e.preventDefault();
      var key = decodeURIComponent(href.slice(6));
      var t = document.getElementById("tab-" + key);
      if (t) { t.click(); t.scrollIntoView({ block: "center" }); }
    });
  });

  // ---- the sticky team header -------------------------------------------
  // Scrolling twenty sections loses the board name and every KPI, so by the
  // time somebody is reading a column-ageing table they can no longer see WHICH
  // board it is. A one-line bar restores the two facts that matter.
  //
  // Deliberately not the KPI grid made position:sticky. Six tiles pinned to the
  // viewport eat a third of a laptop screen, so the reader loses the panel they
  // were reading to the thing reminding them what they were reading.
  //
  // Driven by IntersectionObserver where it exists and by nothing at all where
  // it does not: this is a convenience, and a scroll handler firing on every
  // frame across a multi-megabyte document to provide a convenience is a poor
  // trade.
  if (typeof IntersectionObserver !== "undefined") {
    document.querySelectorAll("[data-team-head]").forEach(function (head) {
      var key = head.getAttribute("data-team-head");
      var bar = document.querySelector('[data-sticky-for="' + key + '"]');
      if (!bar) return;
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          // Shown once the head has left the top of the viewport upwards.
          // Checking boundingClientRect.top as well as isIntersecting keeps the
          // bar hidden when the head is merely below the fold, which is what
          // every other team's head is at all times.
          bar.hidden = entry.isIntersecting || entry.boundingClientRect.top > 0;
        });
      }, { threshold: 0 }).observe(head);
    });
  }

  // ---- per-team Markdown ------------------------------------------------
  // "--team fs" exists on the CLI, but a reader holding the finished file
  // cannot hand somebody one board without going back and regenerating - which
  // needs the repo, the snapshot and the credentials they probably do not have.
  //
  // Built by WALKING THE RENDERED DOM, exactly like the summary copier and for
  // the same reason: every figure in the output is the figure on the screen, so
  // the two cannot disagree. No number is computed here.
  function mdOfTeam(key) {
    var panel = document.getElementById("panel-" + key);
    if (!panel) return "";
    var out = [];
    var head = panel.querySelector(".team-head h2");
    out.push("# " + (head ? head.textContent.replace(/\s+/g, " ").replace(/Copy this team as Markdown/g, "").trim() : key));
    out.push("");
    out.push("Generated from the Cadence report for " + (document.querySelector(".masthead .sub") || { textContent: "" }).textContent.replace(/\s+/g, " ").trim() + ".");

    // The KPI row, then each section: heading, its lede, and any table as a
    // Markdown table. Charts are skipped - their numbers are in the tables and
    // the KPI tiles by construction, which is the whole premise of this page.
    panel.querySelectorAll(".team-head .kpi").forEach(function (k) {
      var label = k.querySelector(".label"), value = k.querySelector(".value"), note = k.querySelector(".note");
      if (!label || !value) return;
      out.push("- **" + label.textContent.trim() + "**: " + value.textContent.trim() +
        (note ? " (" + note.textContent.replace(/\s+/g, " ").trim() + ")" : ""));
    });

    panel.querySelectorAll("section.panel[data-section]").forEach(function (sec) {
      var h = sec.querySelector("h2");
      out.push("");
      out.push("## " + (h ? h.textContent.replace(/Ask Claude/g, "").replace(/\s+/g, " ").trim() : ""));
      var lede = sec.querySelector(".lede");
      if (lede) { out.push(""); out.push(lede.textContent.replace(/\s+/g, " ").trim()); }
      sec.querySelectorAll("table").forEach(function (table) {
        var rows = [];
        var headCells = table.tHead && table.tHead.rows[0]
          ? Array.prototype.slice.call(table.tHead.rows[0].cells).map(cellText) : [];
        if (headCells.length) {
          rows.push("| " + headCells.join(" | ") + " |");
          rows.push("|" + headCells.map(function () { return " --- "; }).join("|") + "|");
        }
        var body = table.tBodies[0];
        if (body) {
          // Rows hidden by a live filter are skipped: what gets copied is what
          // the reader is looking at.
          Array.prototype.slice.call(body.rows).slice(0, 40).forEach(function (r) {
            if (r.hasAttribute("data-filtered")) return;
            rows.push("| " + Array.prototype.slice.call(r.cells).map(cellText).join(" | ") + " |");
          });
        }
        if (rows.length > 2) { out.push(""); out.push(rows.join("\n")); }
      });
    });
    out.push("");
    out.push("_Every figure above was read back out of the rendered report, not recomputed._");
    return out.join("\n");
  }
  function cellText(c) {
    return c.textContent.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim() || "—";
  }
  document.querySelectorAll("[data-md-team]").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      var key = btn.getAttribute("data-md-team");
      var md = mdOfTeam(key);
      if (!md) return;
      var was = btn.textContent;
      copyText(md, "Copied " + key + " as Markdown.");
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = was; }, 1600);
    });
  });

  // ---- the search palette ----------------------------------------------
  // Ctrl-K over everything in the file.
  //
  // WHY THE BROWSER'S OWN Ctrl-F IS NOT ENOUGH, which is the whole reason this
  // exists: most of this document is inside HIDDEN tab panels. Ctrl-F matches
  // text in them and scrolls to nothing, so a reader searching for a ticket
  // that IS in the report concludes it is not - which is worse than not being
  // able to search at all. This opens the right view and the right tab first,
  // then goes to the row.
  //
  // The index is built from the ALREADY-RENDERED DOM. It computes nothing and
  // invents no entry: every result is a link to something the server put on the
  // page. Built lazily on first open.
  var paletteBackdrop = document.getElementById("palette-backdrop");
  var paletteInput = document.getElementById("palette-input");
  var paletteResults = document.getElementById("palette-results");
  var paletteIndex = null;
  var paletteActive = 0;
  var paletteShown = [];

  function teamOf(el) {
    var panel = el.closest ? el.closest(".tabpanel[id^='panel-']") : null;
    if (!panel) return null;
    var id = panel.id.replace(/^panel-/, "");
    return id.indexOf("view-") === 0 ? null : id;
  }
  function viewOf(el) {
    var host = el.closest ? el.closest(".tabpanel[id^='panel-view-']") : null;
    return host ? host.id.replace(/^panel-view-/, "") : null;
  }

  function buildPaletteIndex() {
    var seen = {};
    var out = [];
    function push(kind, label, detail, el) {
      var dedupe = kind + "|" + label + "|" + (teamOf(el) || "");
      if (seen[dedupe]) return;
      seen[dedupe] = true;
      out.push({ kind: kind, label: label, detail: detail || "", el: el, hay: (label + " " + (detail || "")).toLowerCase() });
    }

    // Views and team tabs first: they are what a reader types two letters of.
    document.querySelectorAll("[data-tabs] [role=tab]").forEach(function (t) {
      var grp = t.closest("[data-tabs]").getAttribute("data-tabs");
      push(grp === "view" ? "view" : "team", t.textContent.replace(/\s+/g, " ").trim(), grp === "view" ? "report view" : "board", t);
    });
    // Every panel on the page, per team, so "ageing" lands on the right one.
    document.querySelectorAll("section.panel[data-section]").forEach(function (sec) {
      var h = sec.querySelector("h2");
      var team = teamOf(sec);
      push("panel", (h ? h.textContent.replace(/Ask Claude/g, "").replace(/\s+/g, " ").trim() : sec.id), team ? "panel · " + team : "panel", sec);
    });
    // Tickets, from what the report already rendered. Two shapes, because two
    // helpers produce them: ticket() wraps the key in a .ticket span carrying
    // the hover text, and link(..., "key") emits a bare a.key. Indexing only
    // one of them would make roughly half the ticket keys in the file
    // unsearchable. (No backticks anywhere in this file: it is one String.raw
    // template and a backtick in a COMMENT ends the whole script.)
    document.querySelectorAll(".ticket, a.key").forEach(function (el) {
      var tipText = el.getAttribute("data-tip") || el.getAttribute("data-title") || el.getAttribute("title") || "";
      var label = el.textContent.replace(/\s+/g, " ").trim();
      if (!label) return;
      push("ticket", label, tipText.replace(/\s+/g, " ").slice(0, 160), el);
    });
    document.querySelectorAll("#people-table tbody tr").forEach(function (tr) {
      var c0 = tr.cells[0];
      if (!c0) return;
      var label = c0.textContent.replace(/\s+/g, " ").trim();
      if (label) push("person", label, "person", tr);
    });
    document.querySelectorAll("#estate-epics-table tbody tr").forEach(function (tr) {
      var k = tr.querySelector(".key");
      if (!k) return;
      var name = tr.querySelector(".muted");
      push("epic", k.textContent.trim(), name ? name.textContent.replace(/\s+/g, " ").trim() : "epic", tr);
    });
    return out;
  }

  function openPalette() {
    if (!paletteBackdrop || !paletteInput) return;
    if (!paletteIndex) paletteIndex = buildPaletteIndex();
    paletteBackdrop.hidden = false;
    paletteInput.value = "";
    renderPalette("");
    paletteInput.focus();
  }
  function closePalette() {
    if (!paletteBackdrop) return;
    paletteBackdrop.hidden = true;
  }

  function renderPalette(q) {
    if (!paletteResults || !paletteIndex) return;
    var query = q.trim().toLowerCase();
    // With no query the list is the navigation - views and boards - rather than
    // the first forty tickets in document order, which would be an arbitrary
    // forty and would suggest the search had already run.
    var pool = query
      ? paletteIndex.filter(function (e) { return e.hay.indexOf(query) !== -1; })
      : paletteIndex.filter(function (e) { return e.kind === "view" || e.kind === "team"; });
    // Exact-prefix matches first: somebody typing a ticket key wants that
    // ticket, not the eleven tickets whose latest comment mentions it.
    if (query) {
      pool = pool.slice().sort(function (a, b) {
        var ap = a.label.toLowerCase().indexOf(query) === 0 ? 0 : 1;
        var bp = b.label.toLowerCase().indexOf(query) === 0 ? 0 : 1;
        return ap - bp || a.label.length - b.label.length;
      });
    }
    paletteShown = pool.slice(0, 40);
    paletteActive = 0;
    paletteResults.innerHTML = paletteShown.length
      ? paletteShown.map(function (e, i) {
          return '<li role="option" class="' + (i === 0 ? "on" : "") + '" data-i="' + i + '">' +
            '<span class="pk">' + e.kind + '</span>' +
            '<span class="pl"></span><span class="pd"></span></li>';
        }).join("")
      : '<li class="pnone">Nothing in this file matches that. Tickets are searchable only where the report rendered them &mdash; every list on this page is bounded, and the rest is in the embedded JSON.</li>';
    // Text is set as text, never interpolated into the markup above: a ticket
    // summary is arbitrary content out of Jira and it reaches this function
    // unescaped.
    Array.prototype.slice.call(paletteResults.querySelectorAll("li[data-i]")).forEach(function (li, i) {
      li.querySelector(".pl").textContent = paletteShown[i].label;
      li.querySelector(".pd").textContent = paletteShown[i].detail;
    });
  }

  function goPalette(entry) {
    if (!entry) return;
    closePalette();
    // A tab is activated rather than scrolled to.
    if (entry.kind === "view" || entry.kind === "team") { entry.el.click(); entry.el.scrollIntoView({ block: "center" }); return; }
    // Anything else needs its containing view and tab opened first, or the
    // scroll lands on a hidden element and nothing appears to happen - the
    // exact failure Ctrl-F has.
    var view = viewOf(entry.el);
    if (view) {
      var vt = document.getElementById("tab-view-" + view);
      if (vt) vt.click();
    }
    var team = teamOf(entry.el);
    if (team) {
      var tt = document.getElementById("tab-" + team);
      if (tt) tt.click();
    }
    // Open every collapsed ancestor before scrolling. A scrollIntoView on an
    // element inside a closed <details> silently does nothing, so a hit inside
    // a collapsed section would scroll nowhere - the exact failure this palette
    // exists to fix. Walks OUTWARD from the hit, so a row inside a collapsed
    // table inside a collapsed section opens both.
    for (var anc = entry.el.closest("details"); anc;
         anc = anc.parentElement && anc.parentElement.closest("details")) {
      anc.open = true;
    }
    window.setTimeout(function () {
      entry.el.scrollIntoView({ block: "center", behavior: "smooth" });
      var row = entry.el.closest ? (entry.el.closest("tr") || entry.el) : entry.el;
      row.classList.add("sec-landed");
      window.setTimeout(function () { row.classList.remove("sec-landed"); }, 2200);
    }, 40);
  }

  var searchBtn = document.getElementById("search-open");
  if (searchBtn) searchBtn.addEventListener("click", openPalette);
  if (paletteBackdrop) {
    paletteBackdrop.addEventListener("click", function (e) { if (e.target === paletteBackdrop) closePalette(); });
  }
  if (paletteInput) {
    paletteInput.addEventListener("input", function () { renderPalette(paletteInput.value); });
    paletteInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closePalette(); return; }
      if (e.key === "Enter") { e.preventDefault(); goPalette(paletteShown[paletteActive]); return; }
      var d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (!d || !paletteShown.length) return;
      e.preventDefault();
      paletteActive = (paletteActive + d + paletteShown.length) % paletteShown.length;
      Array.prototype.slice.call(paletteResults.querySelectorAll("li[data-i]")).forEach(function (li, i) {
        if (i === paletteActive) { li.classList.add("on"); li.scrollIntoView({ block: "nearest" }); }
        else li.classList.remove("on");
      });
    });
  }
  if (paletteResults) {
    paletteResults.addEventListener("click", function (e) {
      var li = e.target.closest ? e.target.closest("li[data-i]") : null;
      if (li) goPalette(paletteShown[parseInt(li.getAttribute("data-i"), 10)]);
    });
  }
  document.addEventListener("keydown", function (e) {
    // Ctrl-K and Cmd-K. Not "/" - this report is full of filter inputs and a
    // bare slash would fight every one of them.
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (paletteBackdrop && paletteBackdrop.hidden) openPalette(); else closePalette();
    }
  });

  // ---- boot ---------------------------------------------------------------
  // Order matters. The theme is restored BEFORE any tab opens, so the first
  // chart, if one opens, is built against the palette it will be read in and
  // never has to be thrown away and redrawn on load.
  applyTheme(storedTheme());

  // GOTCHA: this used to fall back to "open the first tab" whenever the page
  // loaded with no #team= hash at all, and that is not a neutral default - the
  // first tab is whichever team's project prefix sorts first ALPHABETICALLY
  // (groupByPrefix in model.ts), which has nothing to do with which team needs
  // looking at. It also called history.replaceState on every plain load, so
  // opening the freshly generated file put an unearned "#team=fcp" in the
  // address bar before the reader had looked at anything. The page already has
  // a genuinely team-neutral landing view above the tabs - Act on this, the
  // triage banner, the portfolio table - so a plain load now leaves every panel
  // exactly as the server rendered it (hidden) and lets that view be the
  // landing page.
  //
  // A hash that NAMES a team and fails to match (a stale link, a typo) is
  // different: the reader came from a specific intent to see a team, so that
  // case still falls back to the first tab rather than silently showing them
  // nothing.
  //
  // The TEAM key specifically, not any hash: "#view=people" is a request for a
  // view and carries no intent about a board, so it must not trip the
  // fall-back-to-the-first-team branch below.
  var hadTeamHash = parseHash().team !== undefined;
  if (!selectFromHash() && hadTeamHash) {
    var first = document.querySelector("[data-tabs=team] [role=tab]");
    if (first) first.click();
  } else if (!hadTeamHash) {
    // Roving tabindex needs exactly one reachable stop in the team tablist even
    // when nothing is selected yet, or the bar becomes unreachable by keyboard
    // until something else focuses it first. Scoped to the team bar: the view
    // rail ships with its selected tab already at tabIndex 0.
    var firstTab = document.querySelector("[data-tabs=team] [role=tab]");
    if (firstTab) firstTab.tabIndex = 0;
  }

  // Triage cards jump to a team without the browser also scroll-anchoring on the
  // raw id, which would fight the tab logic for the same fragment.
  document.querySelectorAll(".triage-card a[data-target]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      var t = document.getElementById(a.getAttribute("data-target-tab"));
      if (t) { t.click(); t.scrollIntoView({ block: "center" }); }
    });
  });

  drawPending();
  window.addEventListener("resize", drawPending);
})();
`;
