import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Birga — collaborative editor",
  description: "Many people, one document, no conflicts. Built on CRDTs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="mx-auto max-w-3xl px-4 py-8">
          <header className="mb-6 flex items-baseline justify-between">
            <a href="/" className="text-lg font-bold tracking-tight">
              Birga
            </a>
            <span className="text-xs text-slate-500">many people · one document · no conflicts</span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
