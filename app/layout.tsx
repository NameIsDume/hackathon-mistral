import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Incident reports",
  description: "Live reports of the incidents reported on Slack.",
};

// Light only, like the reference design on paper.
export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f6f6f4",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${sourceSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <p
          role="status"
          className="border-b border-border bg-card px-4 py-2 text-center text-xs font-medium text-muted-foreground"
        >
          Demo: fictitious data only. Do not enter any real incident here.
        </p>
        {children}
      </body>
    </html>
  );
}
