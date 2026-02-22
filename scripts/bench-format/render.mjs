import { pctDelta, round1 } from "./stats.mjs";

function formatNumber(value, digits = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(digits);
}

function formatMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  return `${Math.round(value)}ms`;
}

function formatPct(value, digits = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return `${value.toFixed(digits)}%`;
}

function formatSigned(value, digits = 1, suffix = "") {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}${suffix}`;
}

function modeMetric(row, mode) {
  return row.modes?.[mode] ?? null;
}

function buildLeaderboardRows(summary) {
  const rows = summary.rows ?? [];
  return [...rows].sort((left, right) => {
    const lv2 = modeMetric(left, "hashline_v2")?.accuracyPct ?? -1;
    const rv2 = modeMetric(right, "hashline_v2")?.accuracyPct ?? -1;
    if (rv2 !== lv2) return rv2 - lv2;
    const lhash = modeMetric(left, "hashline")?.accuracyPct ?? -1;
    const rhash = modeMetric(right, "hashline")?.accuracyPct ?? -1;
    if (rhash !== lhash) return rhash - lhash;
    return (left.displayName ?? left.modelId).localeCompare(right.displayName ?? right.modelId);
  });
}

export function buildMarkdownReport(summary) {
  const rows = buildLeaderboardRows(summary);
  const lines = [];
  const write = (line = "") => lines.push(line);

  write("# Code Edit Format Benchmark");
  write("");
  write(`Generated: ${summary.meta?.generatedAt ?? "-"}`);
  write(`Preset: ${summary.meta?.preset ?? "-"}`);
  write(`Models: ${(summary.meta?.models ?? []).length}`);
  write(`Tasks: ${(summary.meta?.tasks ?? []).length}`);
  write(`Modes: ${(summary.meta?.modes ?? []).join(", ")}`);
  write(`Runs: ${summary.meta?.runCount ?? 0} measured + ${summary.meta?.warmupCount ?? 0} warmup`);
  write("");

  if ((summary.failures ?? []).length > 0) {
    write("## Failures");
    write("");
    for (const failure of summary.failures.slice(0, 20)) {
      write(`- ${failure.modelId} / ${failure.mode} / ${failure.taskId} / ${failure.phase}: ${failure.reason}`);
    }
    if (summary.failures.length > 20) {
      write(`- ... ${summary.failures.length - 20} more`);
    }
    write("");
  }

  write("## Leaderboard (Accuracy First)");
  write("");
  write("| # | Model | Patch | Replace | Hashline | Hashline v2 | Delta v2 vs Patch | Delta v2 vs Replace | Tokens v2 vs Replace |");
  write("|---|-------|------:|--------:|---------:|------------:|--------------:|----------------:|--------------------:|");
  rows.forEach((row, index) => {
    const patch = modeMetric(row, "patch");
    const replace = modeMetric(row, "replace");
    const hashline = modeMetric(row, "hashline");
    const hashlineV2 = modeMetric(row, "hashline_v2");
    const v2VsPatch = (hashlineV2 && patch) ? round1((hashlineV2.accuracyPct ?? 0) - (patch.accuracyPct ?? 0)) : null;
    const v2VsReplace = (hashlineV2 && replace) ? round1((hashlineV2.accuracyPct ?? 0) - (replace.accuracyPct ?? 0)) : null;
    const tokenDelta = (hashlineV2 && replace)
      ? round1(pctDelta(hashlineV2.tokensTotalP50 ?? NaN, replace.tokensTotalP50 ?? NaN))
      : null;
    write(
      `| ${index + 1} | ${row.displayName} | ${formatPct(patch?.accuracyPct)} | ${formatPct(replace?.accuracyPct)} | ${formatPct(hashline?.accuracyPct)} | ${formatPct(hashlineV2?.accuracyPct)} | ${formatSigned(v2VsPatch)} | ${formatSigned(v2VsReplace)} | ${formatSigned(tokenDelta, 1, "%")} |`,
    );
  });
  write("");

  write("## Per-Mode Timing (p50 wall)");
  write("");
  write("| Model | Patch | Replace | Hashline | Hashline v2 |");
  write("|-------|------:|--------:|---------:|------------:|");
  rows.forEach((row) => {
    write(
      `| ${row.displayName} | ${formatMs(modeMetric(row, "patch")?.wallMsP50)} | ${formatMs(modeMetric(row, "replace")?.wallMsP50)} | ${formatMs(modeMetric(row, "hashline")?.wallMsP50)} | ${formatMs(modeMetric(row, "hashline_v2")?.wallMsP50)} |`,
    );
  });
  write("");

  write("## Notes");
  write("");
  write("- Accuracy is pass rate across the exact same task IDs for each model/mode.");
  write("- Tokens column in dashboard defaults to selected mode vs Replace baseline.");
  write("- Tool names are normalized for analysis (`edit` and `apply_patch` are treated as edit-call family).\n");

  return lines.join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderDashboardHtml(summary) {
  const rows = buildLeaderboardRows(summary);
  const payload = {
    meta: summary.meta,
    rows,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Code Edit Format Benchmark</title>
<style>
:root {
  --bg: #070b18;
  --panel: #0b1123;
  --panel-2: #0f172b;
  --line: rgba(149, 167, 255, 0.16);
  --text: #ecf2ff;
  --muted: #9cb0d9;
  --green: #4cf6a0;
  --green-2: #28d98d;
  --blue: #8fb6ff;
  --chip: rgba(255, 255, 255, 0.05);
  --danger: #ff6b86;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--text);
  background:
    radial-gradient(1000px 500px at 20% -10%, rgba(92, 128, 255, 0.16), transparent 60%),
    radial-gradient(900px 500px at 100% 0%, rgba(76, 246, 160, 0.10), transparent 55%),
    var(--bg);
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
}
.container {
  max-width: 1200px;
  margin: 22px auto;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(255,255,255,0.01), rgba(255,255,255,0));
  box-shadow: 0 20px 80px rgba(0, 0, 0, 0.35);
}
.header h1 {
  margin: 0;
  font-size: 2rem;
  letter-spacing: -0.03em;
}
.header .subtitle {
  margin-top: 8px;
  color: var(--muted);
  font-size: 0.95rem;
}
.header .legend {
  color: var(--muted);
}
.header .legend b { color: var(--green); font-weight: 700; }
.meta {
  margin-top: 6px;
  font-size: 0.8rem;
  color: var(--muted);
}
.controls {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.controls .label {
  color: var(--muted);
  font-size: 0.9rem;
}
.button {
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.02);
  color: var(--text);
  border-radius: 999px;
  padding: 8px 14px;
  font-size: 0.85rem;
  cursor: pointer;
}
.button.active {
  border-color: rgba(76, 246, 160, 0.7);
  box-shadow: inset 0 0 0 1px rgba(76, 246, 160, 0.18);
  background: rgba(76, 246, 160, 0.08);
}
.table {
  margin-top: 18px;
  border-top: 1px solid var(--line);
}
.header-row, .row {
  display: grid;
  grid-template-columns: 58px minmax(170px, 220px) minmax(380px, 1fr) 85px 85px 90px;
  gap: 12px;
  align-items: center;
}
.header-row {
  color: var(--muted);
  font-size: 0.78rem;
  padding: 12px 14px;
}
.row {
  margin-top: 8px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
}
.rank {
  color: var(--blue);
  font-weight: 700;
  text-align: right;
}
.model {
  font-weight: 600;
  line-height: 1.15;
}
.model small {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-weight: 500;
}
.bars { display: grid; gap: 7px; }
.bar-line {
  display: grid;
  grid-template-columns: 84px 1fr 74px;
  gap: 8px;
  align-items: center;
}
.bar-label {
  color: var(--muted);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.bar-track {
  position: relative;
  height: 22px;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.04);
  background: rgba(255,255,255,0.03);
  overflow: hidden;
}
.bar-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0%;
  background: linear-gradient(90deg, rgba(255,255,255,0.08), rgba(255,255,255,0.10));
}
.bar-fill.hashline, .bar-fill.hashline_v2 {
  background: linear-gradient(90deg, rgba(40, 217, 141, 0.50), rgba(76, 246, 160, 0.78));
}
.bar-fill.selected {
  box-shadow: 0 0 20px rgba(76, 246, 160, 0.22);
}
.bar-value {
  text-align: right;
  font-weight: 700;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.badge {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  min-width: 56px;
  padding: 4px 10px;
  border-radius: 999px;
  font-weight: 700;
  font-size: 0.85rem;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.03);
  color: var(--muted);
}
.badge.pos {
  color: var(--green);
  border-color: rgba(76,246,160,0.24);
  background: rgba(76,246,160,0.08);
}
.badge.neg {
  color: var(--danger);
  border-color: rgba(255,107,134,0.22);
  background: rgba(255,107,134,0.07);
}
.badge.neutral { color: var(--muted); }
.details {
  margin-top: 6px;
  color: var(--muted);
  font-size: 0.75rem;
}
@media (max-width: 980px) {
  .header-row { display: none; }
  .row {
    grid-template-columns: 42px 1fr;
    gap: 8px;
  }
  .row > .metric, .row > .token { grid-column: 2 / -1; }
}
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Code Edit Format Benchmark</h1>
      <div class="subtitle">
        <span class="legend">Patch · Replace · <b>Hashline</b> · <b>Hashline v2</b></span>
        <span> - accuracy across ${(summary.meta?.models ?? []).length} models</span>
      </div>
      <div class="meta">Preset: ${escapeHtml(summary.meta?.preset ?? "-")} | Tasks: ${(summary.meta?.tasks ?? []).length} | Modes: ${escapeHtml((summary.meta?.modes ?? []).join(", "))} | Generated: ${escapeHtml(summary.meta?.generatedAt ?? "-")}</div>
    </div>
    <div class="controls">
      <span class="label">Sort</span>
      <button class="button active" data-sort="deltaVsReplaceHashline">Delta vs Replace</button>
      <button class="button" data-sort="deltaVsPatchHashline">Delta vs Patch</button>
      <button class="button" data-sort="hashlinePct">Hashline %</button>
      <button class="button" data-sort="hashlineV2Pct">Hashline v2 %</button>
    </div>
    <div class="table">
      <div class="header-row">
        <div></div>
        <div>MODEL</div>
        <div></div>
        <div>Delta Patch</div>
        <div>Delta Repl.</div>
        <div>TOKENS</div>
      </div>
      <div id="rows"></div>
    </div>
  </div>
<script>
const data = ${JSON.stringify(payload)};

function round1(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

function pct(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) + '%' : '-';
}

function badge(v, suffix = '') {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return '<span class="badge neutral">-</span>';
  }
  const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'neutral';
  const sign = v > 0 ? '+' : '';
  return '<span class="badge ' + cls + '">' + sign + v.toFixed(1) + suffix + '</span>';
}

function mode(row, name) {
  return (row.modes && row.modes[name]) || {};
}

function tokenDeltaPct(selected, replace) {
  if (!selected || !replace) return null;
  const a = selected.tokensTotalP50;
  const b = replace.tokensTotalP50;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 100;
}

function toRankData(rows) {
  return rows.map((row) => {
    const patch = mode(row, 'patch');
    const replace = mode(row, 'replace');
    const hashline = mode(row, 'hashline');
    const hashlineV2 = mode(row, 'hashline_v2');
    return {
      ...row,
      _metrics: {
        patchPct: patch.accuracyPct ?? -1,
        replacePct: replace.accuracyPct ?? -1,
        hashlinePct: hashline.accuracyPct ?? -1,
        hashlineV2Pct: hashlineV2.accuracyPct ?? -1,
        deltaVsReplaceHashline: Number.isFinite(hashline.accuracyPct) && Number.isFinite(replace.accuracyPct)
          ? hashline.accuracyPct - replace.accuracyPct
          : -999,
        deltaVsPatchHashline: Number.isFinite(hashline.accuracyPct) && Number.isFinite(patch.accuracyPct)
          ? hashline.accuracyPct - patch.accuracyPct
          : -999,
      },
    };
  });
}

const rankedRows = toRankData(data.rows || []);
let activeSort = 'deltaVsReplaceHashline';

function sortRows(rows, key) {
  return [...rows].sort((a, b) => {
    const diff = (b._metrics[key] ?? -999) - (a._metrics[key] ?? -999);
    if (diff !== 0) return diff;
    const av2 = b._metrics.hashlineV2Pct - a._metrics.hashlineV2Pct;
    if (av2 !== 0) return av2;
    return (a.displayName || a.modelId).localeCompare(b.displayName || b.modelId);
  });
}

function createBarLine(label, metric, selectedKey) {
  const pctValue = metric && Number.isFinite(metric.accuracyPct) ? metric.accuracyPct : 0;
  const modeName = (label === 'PATCH' ? 'patch' : label === 'REPLACE' ? 'replace' : label === 'HASHLINE' ? 'hashline' : 'hashline_v2');
  const selected = selectedKey === 'hashlinePct' ? modeName === 'hashline' : selectedKey === 'hashlineV2Pct' ? modeName === 'hashline_v2' : modeName === 'hashline';
  return ''
    + '<div class="bar-line">'
    + '<div class="bar-label">' + label + '</div>'
    + '<div class="bar-track"><div class="bar-fill ' + modeName + ' ' + (selected ? 'selected' : '') + '" style="width:' + Math.max(0, Math.min(100, pctValue)) + '%"></div></div>'
    + '<div class="bar-value">' + pct(metric ? metric.accuracyPct : null) + '</div>'
    + '</div>';
}

function render() {
  const rowsEl = document.getElementById('rows');
  const rows = sortRows(rankedRows, activeSort);
  rowsEl.innerHTML = rows.map((row, index) => {
    const patch = mode(row, 'patch');
    const replace = mode(row, 'replace');
    const hashline = mode(row, 'hashline');
    const hashlineV2 = mode(row, 'hashline_v2');

    const selectedMode = activeSort === 'hashlineV2Pct' ? hashlineV2 : hashline;
    const deltaPatch = selectedMode && patch && Number.isFinite(selectedMode.accuracyPct) && Number.isFinite(patch.accuracyPct)
      ? round1(selectedMode.accuracyPct - patch.accuracyPct)
      : null;
    const deltaReplace = selectedMode && replace && Number.isFinite(selectedMode.accuracyPct) && Number.isFinite(replace.accuracyPct)
      ? round1(selectedMode.accuracyPct - replace.accuracyPct)
      : null;
    const tokensDelta = tokenDeltaPct(selectedMode, replace);

    const p50V2 = patch && hashlineV2 ? (Number.isFinite(hashlineV2.wallMsP50) ? (hashlineV2.wallMsP50 / 1000).toFixed(1) + 's' : '-') : '-';
    return ''
      + '<div class="row">'
      + '<div class="rank">' + (index + 1) + '</div>'
      + '<div class="model">' + (row.displayName || row.modelId) + '<small>' + row.modelId + '</small></div>'
      + '<div>'
      + '<div class="bars">'
      + createBarLine('PATCH', patch, activeSort)
      + createBarLine('REPLACE', replace, activeSort)
      + createBarLine('HASHLINE', hashline, activeSort)
      + createBarLine('HASHLINE v2', hashlineV2, activeSort)
      + '</div>'
      + '<div class="details">Task pass rate across identical task IDs and measured runs. p50 wall (hashline v2): ' + p50V2 + '</div>'
      + '</div>'
      + '<div class="metric">' + badge(deltaPatch) + '</div>'
      + '<div class="metric">' + badge(deltaReplace) + '</div>'
      + '<div class="token">' + badge(tokensDelta, '%') + '</div>'
      + '</div>';
  }).join('');
}

for (const button of document.querySelectorAll('.button[data-sort]')) {
  button.addEventListener('click', () => {
    activeSort = button.dataset.sort;
    for (const other of document.querySelectorAll('.button[data-sort]')) {
      other.classList.toggle('active', other === button);
    }
    render();
  });
}

render();
</script>
</body>
</html>`;
}
