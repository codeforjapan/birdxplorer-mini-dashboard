import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "コミュニティノートタイムライン 令和8年熊本地震",
  description:
    "令和8年熊本地震（2026年7月28日 16:27 発生・M7.1）に関するXコミュニティノートを継続収集し、内容ごとに分類して時系列で可視化する観測サイト。",
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
