import Link from "next/link";

/** フッタ(design.md §6.7)。データ出典・匿名化方針への導線・運用期間を記す。 */
export function Footer() {
  return (
    <footer className="mx-auto w-full max-w-[1024px] px-4 pb-8 pt-6 text-[11px] text-annotation sm:px-6">
      <p>データ出典: BirdXplorer / Xコミュニティノート。</p>
      <p className="mt-1">
        投稿者情報は匿名化していますが、
        <Link href="/policy" className="underline decoration-line underline-offset-2 hover:text-muted">
          匿名化の方針と限界
        </Link>
        についてはポリシーページを参照してください。
      </p>
      <p className="mt-1">運用期間: 〜2026年8月31日（以降は自動停止し、静的アーカイブとして残置）。</p>
    </footer>
  );
}
