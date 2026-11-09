import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Phase 02 · Hey Gemma, No Internet · VAD + STT",
  description:
    "Silero VAD + Whisper speech-to-text for the Hey Gemma, No Internet workshop.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
