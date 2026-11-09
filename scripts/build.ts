import "./openapi.js";
import { build as bundle } from "esbuild";
import { build } from "vite";
await build();
await bundle({
  entryPoints: ["src/api/handler.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/api/index.js",
  sourcemap: true,
});
