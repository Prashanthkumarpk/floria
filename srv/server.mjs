import express from "express";
import cors from "cors";

const app = express();
const NORTHWIND = "https://services.odata.org/V4/Northwind/Northwind.svc";

// CORS — allow all origins (dev demo)
const corsOpts = { origin: "*", methods: ["GET", "OPTIONS"] };
app.use(cors(corsOpts));
app.options("*", cors(corsOpts)); // explicit preflight pass-through

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
  console.log("   Upstream         → https://services.odata.org/V4/Northwind/Northwind.svc/");
});
