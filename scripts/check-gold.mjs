import { loadGold, loadBenchmarkQueries, validateGold, GOLD_PATH } from "./lib/gold.mjs";

const gold  = loadGold();
const bench = loadBenchmarkQueries();
const errors = validateGold(gold, bench);

if (errors.length) {
  console.error(`✖ ${errors.length} problem(s) in ${GOLD_PATH}:`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
const review = gold.entries.filter(e => e.review).map(e => e.idx);
console.log(`✅ gold_queries.json: ${gold.entries.length} entries aligned with BENCHMARK_QUERIES; all field names valid.`);
if (review.length) console.log(`ℹ  ${review.length} entries flagged review=true: ${review.join(", ")}`);
