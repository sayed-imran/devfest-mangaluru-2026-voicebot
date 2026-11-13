import type { Metadata } from "next";
// Self-hosted Google Sans Flex / Google Sans Code: bundled by npm install, no font CDN,
// so the UI looks the same with the internet unplugged.
import "@fontsource-variable/google-sans-flex";
import "@fontsource-variable/google-sans-code";
import "./globals.css";
import DevFestBar from "@/components/DevFestBar";

export const metadata: Metadata = {
  title: "Phase 01 · Silero VAD · Hey Gemma, No Internet · DevFest Mangaluru 2026",
  description:
    "Browser-only Silero voice activity detection for the Hey Gemma, No Internet workshop.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <DevFestBar phase="01" />
        {children}
      </body>
    </html>
  );
}
