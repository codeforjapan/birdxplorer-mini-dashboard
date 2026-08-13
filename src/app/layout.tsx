import type { Metadata } from "next";
import { EVENT } from "@/lib/event";
import "./globals.css";

export const metadata: Metadata = {
  title: EVENT.siteTitle,
  description: EVENT.siteDescription,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
