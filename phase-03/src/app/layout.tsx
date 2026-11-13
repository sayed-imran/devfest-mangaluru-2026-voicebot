import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Phase 03 · Hey Gemma, No Internet · Chat",
  description:
    "Speak to Gemma 4 on a DGX Spark in the room and read its reply: Silero VAD, Whisper STT, text-only answers.",
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
