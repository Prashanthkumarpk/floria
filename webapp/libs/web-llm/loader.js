// Loads the locally bundled @mlc-ai/web-llm and exposes it as window.mlc
import * as mlc from "./web-llm.js";
window.mlc = mlc;
window.mlcLoaded = true;
