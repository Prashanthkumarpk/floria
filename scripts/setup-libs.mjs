import { copyFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules/@mlc-ai/web-llm/lib/index.js");
const dst = join(root, "webapp/libs/web-llm/web-llm.js");

mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log("✅  Copied web-llm bundle →", dst.replace(root + "/", ""));
