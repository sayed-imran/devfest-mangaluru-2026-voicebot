import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // onnxruntime-web needs client-only bundling
  serverExternalPackages: ["onnxruntime-web"],
  // Allow LAN hostname access during workshop demos
  allowedDevOrigins: ["spark-065b.local", "192.168.0.8"],
};

export default nextConfig;
