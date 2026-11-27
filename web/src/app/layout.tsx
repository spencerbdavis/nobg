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
  openGraph: { title: "nobg — free background remover", description: "Clean cutouts in seconds, right in your browser.", url: "https://nobg.here" },
};

export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: dark)", color: "#151412" }, { color: "#fbf8f3" }] };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${display.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4">
          <Link href="/" className="flex items-center gap-2 font-display text-xl font-extrabold tracking-tight">
            <span aria-hidden className="checker inline-block size-6 rounded-md ring-2 ring-ink" />
            nobg
          </Link>
          <nav className="flex items-center gap-5 text-sm text-muted">
            <Link href="/developers" className="hover:text-ink">API</Link>
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
