import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const display = Bricolage_Grotesque({ variable: "--font-display", subsets: ["latin"], weight: ["600", "800"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://nobg.here"),
  title: "nobg — remove image backgrounds free, instantly, privately",
  description:
    "Free background remover. Drop a photo and get a clean transparent PNG in seconds, processed on your own device. No sign-up, no watermark, full resolution.",
  keywords: ["remove background", "background remover", "transparent PNG", "remove bg", "free", "WebGPU", "cutout"],
  alternates: { canonical: "/" },
  openGraph: { title: "nobg — free background remover", description: "Clean cutouts in seconds, right in your browser. No sign-up, no watermark.", url: "https://nobg.here", siteName: "nobg", type: "website" },
  twitter: { card: "summary_large_image", title: "nobg — free background remover", description: "Clean cutouts in seconds, right in your browser." },
};

export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#151412" }, { color: "#fbf8f3" }] };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${display.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4">
          <Link href="/" className="flex items-center gap-2 font-display text-xl font-extrabold tracking-tight">
            <svg aria-hidden viewBox="0 0 64 64" className="size-7">
              <defs>
                <pattern id="logo-k" width="18" height="18" patternUnits="userSpaceOnUse" x="5" y="5">
                  <rect width="18" height="18" fill="var(--check-a)" />
                  <rect width="9" height="9" fill="var(--check-b)" />
                  <rect x="9" y="9" width="9" height="9" fill="var(--check-b)" />
                </pattern>
              </defs>
              <rect x="5" y="5" width="54" height="54" rx="13" fill="url(#logo-k)" />
              <circle cx="32" cy="32" r="13" fill="var(--accent)" />
              <rect x="5" y="5" width="54" height="54" rx="13" fill="none" stroke="var(--ink)" strokeWidth="6" />
            </svg>
            nobg
          </Link>
          <nav className="flex items-center gap-5 text-sm text-muted">
            <Link href="/developers" className="hover:text-ink">API</Link>
            <a href="https://github.com/spencerbdavis/nobg" className="hover:text-ink">GitHub</a>
          </nav>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="mx-auto w-full max-w-6xl px-5 py-10 text-xs text-muted">
          <p>
            Images are processed on your device when your browser supports WebGPU. Otherwise they’re sent to the nobg server,
            processed in memory and discarded right away. Nothing is stored.
          </p>
          <p className="mt-2">
            Sample photos from Unsplash. Model: ISNet / DIS (Apache-2.0), on your device and on the server.
          </p>
        </footer>
      </body>
    </html>
  );
}
