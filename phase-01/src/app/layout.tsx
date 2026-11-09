import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Phase 01 · Hey Gemma, No Internet · Silero VAD",
  description:
    "Browser-only Silero voice activity detection for the Hey Gemma, No Internet workshop.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
