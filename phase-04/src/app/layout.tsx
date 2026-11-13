import type { Metadata } from "next";
// Self-hosted Google Sans Flex / Google Sans Code: bundled by npm install, no font CDN,
// so the UI looks the same with the internet unplugged.
import "@fontsource-variable/google-sans-flex";
import "@fontsource-variable/google-sans-code";
import "./globals.css";
import DevFestBar from "@/components/DevFestBar";

export const metadata: Metadata = {
  title: "Phase 04 · Voice Chat · Hey Gemma, No Internet · DevFest Mangaluru 2026",
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
      <body>
        <DevFestBar phase="04" sparkChecks={["/api/transcribe", "/api/chat"]} />
        {children}
      </body>
    </html>
  );
}
