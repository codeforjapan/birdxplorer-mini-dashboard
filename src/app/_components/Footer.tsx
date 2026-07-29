/** GitHub Issues。誤分類・レポートの誤り・削除依頼の唯一の受付経路(spec.md §8-8)。 */
const ISSUES_URL = "https://github.com/codeforjapan/kumamoto-earthquake-dashboard/issues";

/**
 * フッタ(design.md §6.8)。データ出典・匿名化方針への導線・運用期間を記す。
 *
 * 加えて、運営主体と訂正窓口、災害の一次情報への導線を置く。無記名のサイトが
 * 他者の投稿を扱うと内容の是非以前に信頼されず、また災害情報を扱いながら
 * 公式発表への導線がないこと自体が指摘対象になるため、UI要件として扱う。
 */
export function Footer() {
  return (
    <footer className="mx-auto w-full max-w-[1024px] px-4 pb-8 pt-6 text-[11px] leading-[1.7] text-annotation sm:px-6">
      <p className="mt-1">
        分類の誤り・レポートの誤り・掲載の削除依頼は
        <External href={ISSUES_URL}>GitHub Issues</External>
        で受け付けています。
      </p>
      <p className="mt-1">
        地震・被害・避難に関する一次情報は
        <External href="https://www.jma.go.jp/">気象庁</External>
        および
        <External href="https://www.pref.kumamoto.jp/">熊本県</External>
        の発表を確認してください。本サイトは防災情報を提供するものではありません。
      </p>
    </footer>
  );
}

function External({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-line underline-offset-2 hover:text-muted"
    >
      {children}
    </a>
  );
}
