import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const app = express();
const NORTHWIND = "https://services.odata.org/V4/Northwind/Northwind.svc";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BEDROCK_REGION = process.env.AWS_REGION ?? "ap-southeast-2";

// CORS — allow all origins (dev demo)
const corsOpts = { origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type"] };
app.use(cors(corsOpts));
app.options("*", cors(corsOpts)); // explicit preflight pass-through
app.use(express.json({ limit: "1mb" }));

// Gold benchmark queries, so the in-app exact-match column reads the same file the scorer does.
app.use("/gold", express.static(join(ROOT, "BENCHMARK/gold")));

// ── Cloud baseline: AWS Bedrock (Claude) ─────────────────────────────────────
// The browser never sees the key; the SDK reads AWS_BEARER_TOKEN_BEDROCK from the
// environment (load it with `node --env-file-if-exists=.env`, see .env.example).
const bedrockEnabled = () => Boolean(process.env.AWS_BEARER_TOKEN_BEDROCK);

// Rewrite cross-region inference prefix to match the actual region, so a model
// ID stored with "us." in the app still works when AWS_REGION=eu-central-1.
// Override with BEDROCK_INFERENCE_PREFIX=eu. (etc.) to pin a specific prefix.
const GEO_PREFIX = /^(us|eu|apac|global)\./;
function regionPrefix(region) {
  if (process.env.BEDROCK_INFERENCE_PREFIX) return process.env.BEDROCK_INFERENCE_PREFIX;
  if (region.startsWith("us-")) return "us.";
  if (region.startsWith("eu-")) return "eu.";
  if (region.startsWith("ap-")) return "apac.";
  return "global.";
}
const resolveModelId = (id) => GEO_PREFIX.test(id) ? id.replace(GEO_PREFIX, regionPrefix(BEDROCK_REGION)) : id;
// AnthropicBedrock uses bedrock-runtime.{region}.amazonaws.com and reads
// AWS_BEARER_TOKEN_BEDROCK automatically for bearer-token auth.
let _bedrockClient = null;
async function getBedrockClient() {
  if (!_bedrockClient) {
    const { AnthropicBedrock } = await import("@anthropic-ai/bedrock-sdk");
    _bedrockClient = new AnthropicBedrock({ awsRegion: BEDROCK_REGION });
  }
  return _bedrockClient;
}

async function bedrockConverse(resolvedModelId, { system, user, maxTokens }) {
  const client = await getBedrockClient();
  return client.messages.create({
    model: resolvedModelId,
    max_tokens: maxTokens,
    system: system || undefined,
    messages: [{ role: "user", content: user }],
  });
}

app.get("/llm/bedrock/health", (_req, res) => {
  const enabled = bedrockEnabled();
  res.json({
    enabled,
    region: BEDROCK_REGION,
    reason: enabled ? null : "AWS_BEARER_TOKEN_BEDROCK is not set — add it to .env and restart the proxy.",
  });
});

app.post("/llm/bedrock", async (req, res) => {
  if (!bedrockEnabled()) return res.status(503).json({ error: "AWS_BEARER_TOKEN_BEDROCK is not set on the proxy." });
  const { modelId, system, user, maxTokens = 150 } = req.body ?? {};
  if (!modelId || !user) return res.status(400).json({ error: "modelId and user are required." });
  const resolvedModelId = resolveModelId(modelId);

  const t0 = performance.now();
  try {
    const out = await bedrockConverse(resolvedModelId, { system, user, maxTokens });
    // /invoke returns Anthropic Messages API format: out.content[].text
    const text = (out.content ?? []).map(c => c.text ?? "").join("");
    res.json({ text, usage: out.usage ?? null, stopReason: out.stop_reason ?? null, latencyMs: Math.round(performance.now() - t0), resolvedModelId });
  } catch (err) {
    res.status(502).json({ error: String(err?.message ?? err) });
  }
});

// ── Northwind proxy ──────────────────────────────────────────────────────────
// Transparent proxy for every path under /odata/
// Express 4: wildcard matched via req.params[0], not :param(*) syntax
app.get("/odata/*", async (req, res) => {
  try {
    const segment = req.params[0] ?? "";          // e.g. "Products" or "$metadata" or ""
    const upstream = new URL(`${NORTHWIND}/${segment}`);

    // Forward all OData system query options ($filter, $top, etc.)
    for (const [key, val] of Object.entries(req.query)) {
      upstream.searchParams.set(key, String(val));
    }

    const response = await fetch(upstream.toString(), {
      headers: { Accept: "application/json;odata.metadata=minimal" }
    });

    const ct = response.headers.get("content-type") ?? "";
    if (ct.includes("xml")) {
      res.type("application/xml").send(await response.text());
    } else {
      res.json(await response.json());
    }
  } catch (err) {
    res.status(502).json({ error: { message: String(err.message) } });
  }
});

app.get("/odata", (_req, res) => res.redirect("/odata/"));

app.listen(4004, () => {
  console.log("✅  Northwind proxy  → http://localhost:4004/odata/");
  console.log("   Gold queries     → http://localhost:4004/gold/gold_queries.json");
  console.log(`   Bedrock baseline → ${bedrockEnabled() ? `enabled (${BEDROCK_REGION})` : "disabled — set AWS_BEARER_TOKEN_BEDROCK in .env"}`);
  console.log("   Upstream         → https://services.odata.org/V4/Northwind/Northwind.svc/");
});
