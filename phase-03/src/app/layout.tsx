import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Phase 03 · Hey Gemma, No Internet · Chat",
  description:
    "Voice + text chat with Silero VAD and Gemma 4 running locally on LiteRT-LM.",
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
