/**
 * Exact-match (EM) scoring for Floria benchmark runs.
 *
 *   npm run score                 score every BENCHMARK/runs/*.json against the gold file
 *   npm run score -- --self-test  run normalizer equivalence checks only
 *
 * EM = entity matches AND normalized $filter ∈ {gold.filter} ∪ gold.alt.
 * ESR false positive = ESR passed (entity + ≥1 row) but EM failed.
 * $top / $orderby are recorded in mismatches.json but do not affect EM.
 *
 * Run files may hold several repetitions (schemaVersion 2, `repetitions[]`) or a single
 * `results[]`. Repetitions — in one file or across files — are aggregated per modelId
 * into mean ± sample sd. Direct (keyword) and cloud (Bedrock) runs are scored like any
 * other model so they appear as baseline rows.
 *
 * Outputs: BENCHMARK/exact_match/{summary.json, summary.md, mismatches.json}
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { loadGold, loadBenchmarkQueries, validateGold, RUNS_DIR, OUT_DIR, ROOT } from "./lib/gold.mjs";
import { normalizeFilter, normalizeEntity, normalizeOrderby, extractFromUrl } from "./lib/normalize.mjs";

const TYPES = ["T1", "T2", "T3", "T4", "T5"];
const STALL_MS = 100_000;
const DEFAULT_TOP = 20;
const PROVIDER_LABEL = { webllm: "on-device", bedrock: "cloud baseline", direct: "keyword baseline" };

// ─── self-test ────────────────────────────────────────────────────────────────
if (process.argv.includes("--self-test")) {
  const same = (a, b) => normalizeFilter(a).normalized === normalizeFilter(b).normalized;
  const cases = [
    ["Country eq 'Germany' or Country eq 'France'", "Country eq 'France' or Country eq 'Germany'", true],
    ["contains(ProductName, 'chai')", "contains(ProductName,'chai')", true],
    ["(UnitPrice lt 15) and (UnitsInStock gt 0)", "UnitsInStock gt 0 and UnitPrice lt 15", true],
    ["Discount eq 0.0", "Discount eq 0", true],
    ["Country eq \"USA\"", "country eq 'usa'", true],
    ["((Freight gt 100))", "Freight gt 100", true],
    ["contains(ProductName,'chai') or contains(ProductName,'tofu')", "contains(ProductName,'tofu') or contains(ProductName,'chai')", true],
    ["(Country eq 'UK' or Country eq 'USA') and City eq 'London'", "City eq 'London' and (Country eq 'USA' or Country eq 'UK')", true],
    ["UnitPrice lt 15", "UnitPrice le 15", false],
    ["A eq 1 and B eq 2 or C eq 3", "C eq 3 or A eq 1 and B eq 2", false],
    ["contains(ProductName,'a b')", "contains(ProductName,'a  b')", false],
    ["", "   ", true],
  ];
  let failed = 0;
  for (const [a, b, expect] of cases) {
    const got = same(a, b), ok = got === expect;
    if (!ok) failed++;
    console.log(`${ok ? "✅" : "✖ "} ${JSON.stringify(a)} ${expect ? "==" : "!="} ${JSON.stringify(b)}`
      + (ok ? "" : `   → got ${JSON.stringify(normalizeFilter(a).normalized)} vs ${JSON.stringify(normalizeFilter(b).normalized)}`));
  }
  const u = extractFromUrl("http://localhost:4004/odata/Customers?%24count=true&%24filter=Country+eq+%27Germany%27+or+Country+eq+%27France%27&%24top=20&%24orderby=CompanyName+asc");
  const urlOk = u.entity === "Customers" && u.filter === "Country eq 'Germany' or Country eq 'France'" && u.top === "20" && u.orderby === "CompanyName asc";
  if (!urlOk) failed++;
  console.log(`${urlOk ? "✅" : "✖ "} extractFromUrl round-trip ${JSON.stringify(u)}`);
  console.log(failed ? `\n${failed} self-test(s) FAILED` : "\nAll self-tests passed");
  process.exit(failed ? 1 : 0);
}

// ─── helpers ──────────────────────────────────────────────────────────────────
const pct = (hit, n) => (n ? Math.round((hit / n) * 1000) / 10 : 0);
const meanSd = (xs) => {
  const n = xs.length;
  if (!n) return { mean: 0, sd: 0, n };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean: Math.round(mean * 10) / 10, sd: Math.round(sd * 10) / 10, n };
};
const fmt = (ms) => (ms.n > 1 ? `${ms.mean} ± ${ms.sd}` : `${ms.mean}`);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n === 0 ? 0 : n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2); };

function scoreResult(r, g) {
  let entity = "", filter = "", top = null, orderby = "", source = "none";
  if (r.url) { ({ entity, filter, top, orderby } = extractFromUrl(r.url)); source = "url"; }
  else if (r.plan) { entity = r.plan.entity ?? ""; filter = r.plan.filter ?? ""; top = r.plan.top ?? null; orderby = r.plan.orderby ?? ""; source = "plan"; }
  else entity = r.detectedEntity ?? "";

  const entityMatch = normalizeEntity(entity) === normalizeEntity(g.entity);
  const got = normalizeFilter(filter);
  const accepted = [g.filter, ...(g.alt ?? [])].map(f => normalizeFilter(f).normalized);
  const filterMatch = accepted.includes(got.normalized);
  return {
    em: source !== "none" && entityMatch && filterMatch, entityMatch, filterMatch, source,
    gotEntity: entity, gotFilter: filter, normalizedGot: got.normalized, mixedConnectors: got.mixedConnectors,
    normalizedGold: accepted[0], goldAlt: g.alt ?? [],
    gotTop: top == null ? null : Number(top), topIsDefault: top == null ? null : Number(top) === DEFAULT_TOP,
    gotOrderby: orderby, orderbyMatch: g.orderby == null ? null : normalizeOrderby(orderby) === normalizeOrderby(g.orderby),
  };
}

// ─── gold ─────────────────────────────────────────────────────────────────────
const gold = loadGold();
const goldErrors = validateGold(gold, loadBenchmarkQueries());
if (goldErrors.length) {
  console.error("Gold file is inconsistent with BENCHMARK_QUERIES — fix before scoring:");
  for (const e of goldErrors) console.error("  - " + e);
  process.exit(1);
}
const goldByIdx = new Map(gold.entries.map(e => [e.idx, e]));

// ─── load runs → flat list of repetitions ─────────────────────────────────────
let runFiles = [];
try { runFiles = readdirSync(RUNS_DIR).filter(f => f.endsWith(".json")).sort(); } catch { /* no dir yet */ }
if (runFiles.length === 0) {
  console.error(`No run files found in ${RUNS_DIR}. Run the benchmark in the app, click "JSON", and save the file there.`);
  process.exit(1);
}

const warnings = [], mismatches = [], reps = [];
for (const file of runFiles) {
  const run = JSON.parse(readFileSync(join(RUNS_DIR, file), "utf8"));
  const label = run.model ?? basename(file, ".json");
  const provider = run.provider ?? (run.llmMode === "heuristic" ? "direct" : run.llmMode === "llm" ? "webllm" : run.llmMode) ?? "webllm";
  const list = Array.isArray(run.repetitions) && run.repetitions.length
    ? run.repetitions.map(r => ({ index: r.index, results: r.results ?? [], date: r.startedAt ?? run.date }))
    : [{ index: 1, results: Array.isArray(run.results) ? run.results : [], date: run.date }];

  for (const rep of list) {
    const em  = { total: 0, byType: Object.fromEntries(TYPES.map(t => [t, { n: 0, hit: 0 }])) };
    const esr = { total: 0, byType: Object.fromEntries(TYPES.map(t => [t, { n: 0, hit: 0 }])) };
    const times = []; let scored = 0, fp = 0;

    for (const r of rep.results) {
      // Prefer the gold index recorded by the app; fall back to matching by query text
      // (older run files, or query subsets whose row idx does not equal the gold idx).
      let g = goldByIdx.get(r.goldIdx ?? r.idx);
      if (!g || g.query !== r.query) g = gold.entries.find(e => e.query === r.query);
      if (!g) { warnings.push(`${file} rep ${rep.index}: "${r.query}" has no gold entry (custom query?) — skipped`); continue; }

      scored++; times.push(r.totalMs ?? 0);
      const s = scoreResult(r, g), t = g.type;
      em.byType[t].n++; esr.byType[t].n++;
      if (s.em) { em.total++; em.byType[t].hit++; }
      if (r.passed) { esr.total++; esr.byType[t].hit++; }
      if (r.passed && !s.em) fp++;
      if (!s.em) mismatches.push({
        file, rep: rep.index, model: label, modelId: run.modelId, provider, idx: g.idx, type: t, query: g.query,
        goldFilter: g.filter, goldAlt: s.goldAlt, gotEntity: s.gotEntity, gotFilter: s.gotFilter,
        normalizedGold: s.normalizedGold, normalizedGot: s.normalizedGot, entityMatch: s.entityMatch, filterMatch: s.filterMatch,
        esrPassed: !!r.passed, gotTop: s.gotTop, topIsDefault: s.topIsDefault, gotOrderby: s.gotOrderby, source: s.source,
        url: r.url ?? null, error: r.error ?? null, errorStage: r.errorStage ?? null,
        prePostProcessPlan: r.prePostProcessPlan ?? null, rawLlmText: r.rawLlmText ?? null,
      });
    }
    if (scored < 100) warnings.push(`${file} rep ${rep.index}: only ${scored}/100 gold queries present (partial run)`);
    reps.push({
      file, rep: rep.index, model: label, modelId: run.modelId ?? label, provider, date: rep.date ?? null, promptVersion: run.promptVersion ?? null,
      hardware: run.hardware ?? null, modelSize: run.modelSize ?? null, scored,
      emTotal: em.total, emPct: pct(em.total, scored), emByType: Object.fromEntries(TYPES.map(t => [t, pct(em.byType[t].hit, em.byType[t].n)])), emByTypeRaw: em.byType,
      esrTotal: esr.total, esrPct: pct(esr.total, scored), esrByType: Object.fromEntries(TYPES.map(t => [t, pct(esr.byType[t].hit, esr.byType[t].n)])),
      falsePositives: fp, fpRatePct: pct(fp, esr.total),
      timing: { medianMs: median(times), meanMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0, maxMs: times.length ? Math.max(...times) : 0, stalls: times.filter(x => x > STALL_MS).length },
    });
  }
}

// ─── aggregate per model ──────────────────────────────────────────────────────
const byModel = new Map();
for (const r of reps) { if (!byModel.has(r.modelId)) byModel.set(r.modelId, []); byModel.get(r.modelId).push(r); }
const order = { webllm: 0, bedrock: 1, direct: 2 };
const models = [...byModel.entries()].map(([modelId, rs]) => ({
  modelId, model: rs[0].model, provider: rs[0].provider, runs: rs.length, files: [...new Set(rs.map(r => r.file))],
  promptVersions: [...new Set(rs.map(r => r.promptVersion))], modelSize: rs[0].modelSize, hardware: rs[0].hardware,
  em:  { pct: meanSd(rs.map(r => r.emPct)),  byType: Object.fromEntries(TYPES.map(t => [t, meanSd(rs.map(r => r.emByType[t]))])) },
  esr: { pct: meanSd(rs.map(r => r.esrPct)), byType: Object.fromEntries(TYPES.map(t => [t, meanSd(rs.map(r => r.esrByType[t]))])) },
  fpRatePct: meanSd(rs.map(r => r.fpRatePct)),
  timing: { medianMs: meanSd(rs.map(r => r.timing.medianMs)), maxMs: Math.max(...rs.map(r => r.timing.maxMs)), stalls: rs.reduce((a, r) => a + r.timing.stalls, 0) },
  repetitions: rs,
})).sort((a, b) => (order[a.provider] ?? 9) - (order[b.provider] ?? 9) || b.em.pct.mean - a.em.pct.mean);

// ─── outputs ──────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const md = [];
md.push(`# Exact-match vs ESR — ${new Date().toISOString().slice(0, 10)}`, "");
md.push(`Gold: ${gold.entries.length} queries · EM = entity + normalized $filter · ${reps.length} repetition(s) across ${models.length} model(s). Values are % (mean ± sample sd when n > 1).`, "");
md.push("## Exact match by type", "", `| Model | kind | n | ${TYPES.join(" | ")} | **EM** | ESR | ESR FP rate |`, `|---|---|---|${TYPES.map(() => "---").join("|")}|---|---|---|`);
for (const m of models) md.push(`| ${m.model} | ${PROVIDER_LABEL[m.provider] ?? m.provider} | ${m.runs} | ${TYPES.map(t => fmt(m.em.byType[t])).join(" | ")} | **${fmt(m.em.pct)}** | ${fmt(m.esr.pct)} | ${fmt(m.fpRatePct)} |`);
md.push("", "## ESR by type (same runs)", "", `| Model | ${TYPES.join(" | ")} | ESR |`, `|---|${TYPES.map(() => "---").join("|")}|---|`);
for (const m of models) md.push(`| ${m.model} | ${TYPES.map(t => fmt(m.esr.byType[t])).join(" | ")} | ${fmt(m.esr.pct)} |`);
md.push("", "## Timing", "", "| Model | median ms (mean ± sd over runs) | max ms | stalls (>100 s, all runs) | size | GPU |", "|---|---|---|---|---|---|");
for (const m of models) {
  const g = m.hardware?.gpu; const gpu = g ? [g.vendor, g.architecture, g.device].filter(Boolean).join(" ") : "n/a";
  md.push(`| ${m.model} | ${fmt(m.timing.medianMs)} | ${m.timing.maxMs} | ${m.timing.stalls} | ${m.modelSize ?? ""} | ${gpu} |`);
}
md.push("", "## Per-repetition detail", "", "| Model | file | rep | EM | ESR | FP | median ms |", "|---|---|---|---|---|---|---|");
for (const r of reps) md.push(`| ${r.model} | ${r.file} | ${r.rep} | ${r.emTotal}/${r.scored} (${r.emPct}%) | ${r.esrTotal}/${r.scored} (${r.esrPct}%) | ${r.falsePositives} (${r.fpRatePct}%) | ${r.timing.medianMs} |`);
md.push("", "## LaTeX rows for Table I (Model & T1..T5 EM & ESR & EM & ESR FP rate), mean ± sd when n > 1", "", "```latex");
const tex = (ms) => (ms.n > 1 ? `${ms.mean}\\% $\\pm$ ${ms.sd}` : `${ms.mean}\\%`);
for (const m of models) md.push(`${m.model} & ${TYPES.map(t => tex(m.em.byType[t])).join(" & ")} & ${tex(m.esr.pct)} & ${tex(m.em.pct)} & ${tex(m.fpRatePct)} \\\\`);
md.push("```", "");
if (warnings.length) { md.push("## Warnings", ""); for (const w of warnings) md.push(`- ${w}`); md.push(""); }
md.push(`Mismatches: ${mismatches.length} (see mismatches.json)`, "");

writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), gold: { count: gold.entries.length, path: "BENCHMARK/gold/gold_queries.json" }, models, warnings }, null, 2));
writeFileSync(join(OUT_DIR, "summary.md"), md.join("\n"));
writeFileSync(join(OUT_DIR, "mismatches.json"), JSON.stringify(mismatches, null, 2));

console.log(md.join("\n"));
console.log(`Wrote ${OUT_DIR.replace(ROOT + "/", "")}/{summary.json, summary.md, mismatches.json}`);
