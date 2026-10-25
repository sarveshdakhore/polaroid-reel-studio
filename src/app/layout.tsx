import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono, Caveat } from "next/font/google";
import "./globals.css";

const sansFont = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
});

const monoFont = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "600", "700"],
});

const handFont = Caveat({
  subsets: ["latin"],
  variable: "--font-hand",
  weight: ["600", "700"],
});

export const metadata: Metadata = {
  title: "Polaroid Reel Studio — 1080×1920 Instant Film Video Generator",
  description:
    "Frontend Polaroid reel generator with sequential story captions powered by Gemini AI, custom film graininess, and exact physics/color grading.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sansFont.variable} ${monoFont.variable} ${handFont.variable}`}
    >
      <body className="min-h-screen bg-[#111110] text-[#f4f0e6] selection:bg-[#e85d04] selection:text-[#111110]">
        {children}
      </body>
    </html>
  );
}
