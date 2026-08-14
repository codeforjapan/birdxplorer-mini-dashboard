"use client";

import { useState } from "react";

/**
 * X / 他プラットフォームの2タブ殻。選択タブだけを描画し、URL の ?tab= に同期する
 * （履歴を汚さない replaceState。共有・リロードで復元できる）。
 * タブ＝タブパネルの関連付け（role/aria）も張る。
 */
export function Tabs({
  initialTab,
  xPanel,
  otherPanel,
}: {
  initialTab: "x" | "other";
  xPanel: React.ReactNode;
  otherPanel: React.ReactNode;
}) {
  const [active, setActive] = useState<"x" | "other">(initialTab);

  const select = (tab: "x" | "other") => {
    setActive(tab);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (tab === "x") url.searchParams.delete("tab");
      else url.searchParams.set("tab", "other");
      window.history.replaceState(null, "", url.toString());
    }
  };

  const tabBtn = (tab: "x" | "other", label: string) => (
    <button
      type="button"
      role="tab"
      id={`tab-${tab}`}
      aria-selected={active === tab}
      aria-controls={`panel-${tab}`}
      onClick={() => select(tab)}
      className={`-mb-[2px] border-b-2 px-4 py-2 text-[13px] font-semibold ${
        active === tab ? "border-heading text-heading" : "border-transparent text-label hover:text-body"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="表示切り替え" className="flex gap-1 border-b-2 border-line">
        {tabBtn("x", "X（コミュニティノート）")}
        {tabBtn("other", "他プラットフォーム")}
      </div>
      <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`}>
        {active === "x" ? xPanel : otherPanel}
      </div>
    </div>
  );
}
