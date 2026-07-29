/**
 * データ取得失敗時の通知(design.md §9)。既存データは隠さずこの1行だけを上に足す。
 */
export function FetchFailureNotice({ asOfLabel }: { asOfLabel: string }) {
  return (
    <p className="mb-4 rounded-md border border-line bg-block px-3 py-2 text-[12px] text-muted">
      データを取得できませんでした。前回取得時点（{asOfLabel}）の内容を表示しています。
    </p>
  );
}
