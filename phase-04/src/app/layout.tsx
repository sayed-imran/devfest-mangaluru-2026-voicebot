import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Phase 04 · Hey Gemma, No Internet · Voice Chat",
  description:
    "Voice + text chat with Silero VAD, Whisper STT, Gemma 4, and Kokoro TTS.",
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
