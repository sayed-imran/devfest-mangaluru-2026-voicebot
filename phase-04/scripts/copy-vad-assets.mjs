import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Dependencies are installed once at the repo root (npm workspaces), so look
// for each package in ./node_modules first and then walk up the parent dirs.
function pkgDir(name) {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Cannot find ${name} — run "npm install" at the repo root first.`);
    }
    dir = parent;
  }
}

const dest = "public/vad";
mkdirSync(dest, { recursive: true });

const vadDist = join(pkgDir("@ricky0123/vad-web"), "dist");
for (const name of [
  "vad.worklet.bundle.min.js",
  "silero_vad_legacy.onnx",
  "silero_vad_v5.onnx",
  "silero_vad_v6.onnx",
]) {
  copyFileSync(join(vadDist, name), join(dest, name));
}

const ortDist = join(pkgDir("onnxruntime-web"), "dist");
for (const file of readdirSync(ortDist)) {
  if (file.endsWith(".wasm") || file.startsWith("ort-wasm-simd-threaded")) {
    copyFileSync(join(ortDist, file), join(dest, file));
  }
}

console.log(`Copied Silero VAD assets to ${resolve(dest)}/`);
