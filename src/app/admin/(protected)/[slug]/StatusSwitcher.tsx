"use client";

import { useState, type TransitionStartFunction } from "react";
import { changeTenantStatusAction } from "@/lib/admin/actions";
import type { TenantStatus } from "@/lib/tenant/types";

const LABEL: Record<TenantStatus, string> = { draft: "下書き", active: "収集中", ended: "終了" };
const CONFIRM: Record<TenantStatus, string> = {
  active: "収集中にすると cron が動き LLM の費用が発生し、公開ページが見えるようになります。よろしいですか？",
  draft: "収集と公開を止めます。集めたデータは残ります。よろしいですか？",
  ended: "収集を止め、最終状態のまま公開します。よろしいですか？",
};

type Props = {
  slug: string;
  status: TenantStatus;
  updatedAt: number;
  pending: boolean;
  startTransition: TransitionStartFunction;
  onChanged: (to: TenantStatus, updatedAt: number) => void;
};

export function StatusSwitcher({ slug, status, updatedAt, pending, startTransition, onChanged }: Props) {
  const [message, setMessage] = useState<string | null>(null);

  const change = (to: TenantStatus) => {
    if (!window.confirm(CONFIRM[to])) return;
    setMessage(null);
    startTransition(async () => {
      const r = await changeTenantStatusAction(slug, to, updatedAt);
      if (r.ok) {
        onChanged(to, r.updatedAt);
        return;
      }
      if (r.updatedAt !== undefined) {
        // DB は進んでいる。状態も反映して、再試行が conflict にならないようにする
        onChanged(to, r.updatedAt);
        setMessage(r.message);
        return;
      }
      setMessage(r.kind === "conflict" ? "ほかの人が更新しました。再読み込みしてください" : r.message);
    });
  };

  const others = (Object.keys(LABEL) as TenantStatus[]).filter((s) => s !== status);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-muted">状態</span>
        <span className="font-bold text-heading">{LABEL[status]}</span>
        {others.map((s) => (
          <button
            key={s}
            type="button"
            disabled={pending}
            onClick={() => change(s)}
            className="rounded border border-line px-2 py-1 text-[12px] text-body hover:text-heading disabled:opacity-50"
          >
            {LABEL[s]}にする
          </button>
        ))}
      </div>
      {message !== null && (
        <p role="alert" className="text-[12px] text-accent">
          {message}
        </p>
      )}
    </div>
  );
}
