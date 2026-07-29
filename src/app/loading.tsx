/**
 * 読み込み中の骨格(design.md §9)。
 * 「スピナーは使わない」ため、カードの外形だけ描き、内容部分は `#FFFFFF`(--color-card)の
 * プレースホルダ矩形で埋める。ページ背景(`--color-page` #F4F6F8)との対比はごく控えめ
 * (実測コントラスト比 約1.08:1)だが、これは骨格表現として意図的なもので、旧仕様の
 * 暗い面でも同程度の控えめな対比(約1.09:1)だった。`globals.css` の
 * `prefers-reduced-motion` 対応に加え、ここでは元々アニメーションを使わない
 * (明滅・パルスもしない)ので追加対応は不要。
 */
function Block({ className = "" }: { className?: string }) {
  return <div className={`rounded bg-card ${className}`} />;
}

export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-[1024px] flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
      <div className="flex flex-col gap-2">
        <Block className="h-3 w-56" />
        <Block className="h-7 w-80 sm:h-8" />
        <Block className="h-3 w-72" />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-line px-4 py-4">
            <Block className="h-2.5 w-16" />
            <Block className="mt-2 h-4 w-20" />
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-line p-4 sm:p-5">
        <Block className="h-4 w-40" />
        <Block className="mt-4 h-[320px] w-full" />
      </div>

      <div className="rounded-xl border border-line p-4 sm:p-5">
        <Block className="h-4 w-24" />
        <Block className="mt-4 h-16 w-full" />
      </div>
    </div>
  );
}
