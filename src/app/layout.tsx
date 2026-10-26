import "./globals.css";

// タイトル・説明は事例ごとに違うので、各ページの generateMetadata が持つ

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
