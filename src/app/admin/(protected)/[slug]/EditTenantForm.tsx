"use client";

import { useState, useTransition } from "react";
import { TenantFormSections } from "@/app/admin/_components/TenantFormSections";
import { updateTenantAction } from "@/lib/admin/actions";
import type { TenantFormValues } from "@/lib/admin/form";
import type { TenantStatus } from "@/lib/tenant/types";
import { StatusSwitcher } from "./StatusSwitcher";

type Props = {
  initial: TenantFormValues;
  initialStatus: TenantStatus;
  initialUpdatedAt: number;
  searchlightTopicId: string | null;
};

type Notice = { tone: "ok" | "error"; text: string };

export function EditTenantForm({ initial, initialStatus, initialUpdatedAt, searchlightTopicId }: Props) {
  const [values, setValues] = useState(initial);
  const [status, setStatus] = useState(initialStatus);
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  // 保存と状態切り替えが並ぶと後の方が自分の更新と競合するので、1つの pending で両方を止める
  const [pending, startTransition] = useTransition();

  const save = () => {
    setNotice(null);
    setErrors({});
    startTransition(async () => {
      const r = await updateTenantAction(values.slug, values, updatedAt);
      if (r.ok) {
        setUpdatedAt(r.updatedAt);
        setNotice({ tone: "ok", text: "保存しました" });
        return;
      }
      // publish-failed は DB が進んでいるので、再保存が conflict にならないよう取り替える
      if (r.updatedAt !== undefined) setUpdatedAt(r.updatedAt);
      if (r.kind === "invalid") {
        setErrors(r.fieldErrors ?? {});
        setNotice({ tone: "error", text: r.message });
      } else if (r.kind === "conflict") {
        setNotice({ tone: "error", text: "ほかの人が更新しました。再読み込みしてください" });
      } else {
        setNotice({ tone: "error", text: r.message });
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-bold text-heading">{values.siteTitle || values.slug}</h1>
          <p className="tabular text-[12px] text-muted">{values.slug}</p>
          <p className="mt-1 text-[12px] text-muted">
            Searchlight topic:{" "}
            <span className="tabular text-body">{searchlightTopicId ?? "未設定"}</span>（変更は{" "}
            <code>tenant-upsert</code> で）
          </p>
        </div>
        <StatusSwitcher
          slug={values.slug}
          status={status}
          updatedAt={updatedAt}
          pending={pending}
          startTransition={startTransition}
          onChanged={(to, at) => {
            setStatus(to);
            setUpdatedAt(at);
          }}
        />
      </div>

      <TenantFormSections values={values} onChange={setValues} errors={errors} section="all" slugEditable={false} />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={save}
          className="rounded-md bg-heading px-4 py-2 text-[13px] font-semibold text-card disabled:opacity-50"
        >
          {pending ? "保存中…" : "保存"}
        </button>
        <span className="text-[12px] text-muted">
          既存ノートには効きません。再分類は <code>/api/admin/reclassify</code>
        </span>
        {notice !== null && (
          <span role="status" className={`text-[13px] ${notice.tone === "ok" ? "text-heading" : "text-accent"}`}>
            {notice.text}
          </span>
        )}
      </div>
    </div>
  );
}
