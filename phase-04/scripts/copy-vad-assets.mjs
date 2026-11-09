import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dest = "public/vad";
mkdirSync(dest, { recursive: true });

const copies = [
  [
    "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",
    "vad.worklet.bundle.min.js",
  ],
  [
    "node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx",
    "silero_vad_legacy.onnx",
  ],
  [
    "node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx",
    "silero_vad_v5.onnx",
  ],
  [
    "node_modules/@ricky0123/vad-web/dist/silero_vad_v6.onnx",
    "silero_vad_v6.onnx",
  ],
];

for (const [from, name] of copies) {
  copyFileSync(from, join(dest, name));
}

const ortDist = "node_modules/onnxruntime-web/dist";
for (const file of readdirSync(ortDist)) {
  if (file.endsWith(".wasm") || file.startsWith("ort-wasm-simd-threaded")) {
    copyFileSync(join(ortDist, file), join(dest, file));
  }
}

console.log(`Copied Silero VAD assets to ${dest}/`);
