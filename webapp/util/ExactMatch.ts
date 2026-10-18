/**
 * ExactMatch.ts
 *
 * In-browser exact-match (EM) scoring of a generated OData plan against a gold query.
 * EM = entity matches AND normalized $filter is in {gold.filter} ∪ gold.alt.
 *
 * This is a TypeScript twin of scripts/lib/normalize.mjs (the offline scorer). Keep the
 * two in step; `node scripts/score-exact-match.mjs --self-test` is the specification,
 * and scripts/check-normalizer-parity.mjs verifies both produce identical output.
 */

export interface GoldEntry {
  idx: number;
  type: string;
  query: string;
  entity: string;
  filter: string;
  alt?: string[];
  note?: string;
  review?: boolean;
}

export function normalizeEntity(e: string | null | undefined): string {
  return String(e ?? "").trim().toLowerCase();
}

/** Apply fn to every stretch of text outside single-quoted string literals. */
function mapOutsideQuotes(s: string, fn: (seg: string) => string): string {
  let out = "", buf = "", inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inQuote) {
      if (ch === "'") { out += fn(buf); buf = ""; out += ch; inQuote = true; }
      else buf += ch;
    } else {
      out += ch;
      if (ch === "'") {
        if (s[i + 1] === "'") { out += "'"; i++; }
        else inQuote = false;
      }
    }
  }
  return out + fn(buf);
}

/** Split on top-level " and " / " or ", respecting parentheses and quoted strings. */
function splitTopLevel(s: string): { operands: string[]; connectors: string[] } {
  const operands: string[] = [], connectors: string[] = [];
  let depth = 0, inQuote = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      cur += ch;
      if (ch === "'") { if (s[i + 1] === "'") { cur += "'"; i++; } else inQuote = false; }
      continue;
    }
    if (ch === "'") { inQuote = true; cur += ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && ch === " ") {
      const m = s.slice(i).match(/^ (and|or) /);
      if (m) { operands.push(cur); connectors.push(m[1]); cur = ""; i += m[0].length - 1; continue; }
    }
    cur += ch;
  }
  operands.push(cur);
  return { operands, connectors };
}

function wrappedInParens(s: string): boolean {
  if (!s.startsWith("(") || !s.endsWith(")")) return false;
  let depth = 0, inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) { if (ch === "'") inQuote = false; continue; }
    if (ch === "'") { inQuote = true; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0 && i < s.length - 1) return false; }
  }
  return depth === 0;
}

function stripOuterParens(s: string): string {
  let t = s.trim();
  while (wrappedInParens(t)) t = t.slice(1, -1).trim();
  return t;
}

const canonNumbers = (s: string): string =>
  mapOutsideQuotes(s, seg => seg.replace(/\b\d+\.\d+\b/g, n => String(Number(n))));

function canonExpr(input: string): { text: string; mixed: boolean } {
  const s = stripOuterParens(input.trim());
  const { operands, connectors } = splitTopLevel(s);
  if (connectors.length === 0) return { text: canonNumbers(s), mixed: false };
  let mixed = new Set(connectors).size > 1;
  const parts = operands.map(op => {
    const inner = stripOuterParens(op.trim());
    if (splitTopLevel(inner).connectors.length === 0) return canonNumbers(inner);
    const r = canonExpr(inner);
    mixed = mixed || r.mixed;
    return `(${r.text})`;
  });
  if (!mixed) parts.sort();
  return { text: parts.join(` ${connectors[0]} `), mixed };
}

/** Canonical form of a $filter expression; "" for empty input. */
export function normalizeFilter(input: string | null | undefined): string {
  let s = String(input ?? "").trim();
  if (!s) return "";
  s = s.toLowerCase().replace(/"/g, "'");
  s = mapOutsideQuotes(s, seg => seg
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ",")
    .replace(/\b(?!and\b|or\b|not\b)([a-z_]\w*)\s+\(/g, "$1(")
  ).trim();
  return canonExpr(s).text;
}

/** Entity and $filter as actually sent, read back from the URL ODataQueryBuilder built. */
export function filterFromUrl(url: string): { entity: string; filter: string } {
  const u = new URL(url);
  const segs = u.pathname.split("/").filter(Boolean);
  return { entity: segs[segs.length - 1] ?? "", filter: u.searchParams.get("$filter") ?? "" };
}

export function isExactMatch(gotEntity: string, gotFilter: string, gold: GoldEntry): boolean {
  if (normalizeEntity(gotEntity) !== normalizeEntity(gold.entity)) return false;
  const got = normalizeFilter(gotFilter);
  return [gold.filter, ...(gold.alt ?? [])].some(f => normalizeFilter(f) === got);
}
