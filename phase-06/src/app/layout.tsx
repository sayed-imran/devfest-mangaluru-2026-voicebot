import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Phase 06 · Hey Gemma, No Internet · Voice + Tools",
  description:
    "Voice + text chat with Silero VAD, Whisper STT, Gemma 4, Kokoro TTS, and MCP tools.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
