import type { Metadata } from "next";
// Self-hosted Google Sans Flex / Google Sans Code: bundled by npm install, no font CDN,
// so the UI looks the same with the internet unplugged.
import "@fontsource-variable/google-sans-flex";
import "@fontsource-variable/google-sans-code";
import "./globals.css";
import DevFestBar from "@/components/DevFestBar";

export const metadata: Metadata = {
  title: "Phase 03 · Chat · Hey Gemma, No Internet · DevFest Mangaluru 2026",
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
      <body>
        <DevFestBar phase="03" sparkChecks={["/api/transcribe", "/api/chat"]} />
        {children}
      </body>
    </html>
  );
}
