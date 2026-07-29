import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "熊本地震（2026/07/28）誤情報タイムライン",
  description:
    "2026年7月28日の熊本地震に関するXコミュニティノートを継続収集し、内容ごとに分類して時系列で可視化する観測サイト。",
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
