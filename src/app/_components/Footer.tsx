import { Fragment } from "react";
import type { PublicTenantConfig } from "@/lib/tenant/types";

/**
 * フッタ(design.md §6.8)。データ出典・匿名化方針への導線・運用期間を記す。
 *
 * 加えて、運営主体と訂正窓口、一次情報への導線を置く。無記名のサイトが
 * 他者の投稿を扱うと内容の是非以前に信頼されず、また一次情報への導線がないこと
 * 自体が指摘対象になるため、UI要件として扱う。
 */
export function Footer({
  config,
}: {
  config: Pick<
    PublicTenantConfig,
    "issuesUrl" | "officialSourcesIntro" | "officialSources" | "officialSourcesDisclaimer"
  >;
}) {
  return (
    <footer className="mx-auto w-full max-w-[1024px] px-4 pb-8 pt-6 text-[11px] leading-[1.7] text-annotation sm:px-6">
      <p className="mt-1">
        分類の誤り・レポートの誤り・掲載の削除依頼は
        <External href={config.issuesUrl}>GitHub Issues</External>
        で受け付けています。
      </p>
      <p className="mt-1">
        {config.officialSourcesIntro}
        {config.officialSources.map((source, i) => (
          <Fragment key={source.url}>
            {i > 0 && "および"}
            <External href={source.url}>{source.label}</External>
          </Fragment>
        ))}
        の発表を確認してください。{config.officialSourcesDisclaimer}
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
