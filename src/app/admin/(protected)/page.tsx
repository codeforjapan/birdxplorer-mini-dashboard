import Link from "next/link";
import { ensureMigrated } from "@/app/api/cron/_lib/migrate-once";
import { tenantHostEnv } from "@/lib/env";
import { parseHostRules } from "@/lib/tenant/host";
import { listTenantsLenient } from "@/lib/tenant/repo";
import { isTenantMonitoringEnded, resolveTenantConfig } from "@/lib/tenant/resolve";
import type { TenantRecord } from "@/lib/tenant/types";
import { isoDate } from "@/lib/time";

export const dynamic = "force-dynamic";

const TYPE_LABEL = { disaster: "災害", election: "選挙" } as const;
const STATUS_LABEL = { draft: "下書き", active: "収集中", ended: "終了" } as const;

function statusLabel(rec: TenantRecord): string {
  if (rec.status === "active" && isTenantMonitoringEnded(resolveTenantConfig(rec))) {
    return "終了日を過ぎた（自動で終了扱い）";
  }
  return STATUS_LABEL[rec.status];
}

function publicUrls(slug: string, rules: ReturnType<typeof parseHostRules>): string[] {
  const urls = rules.parentDomain ? [`https://${slug}.${rules.parentDomain}`] : [];
  for (const [host, target] of Object.entries(rules.aliases)) {
    if (target === slug) urls.push(`https://${host}`);
  }
  return urls;
}

export default async function AdminListPage() {
  // 新しい DB にはまだ tenants が無いことがある
  await ensureMigrated();
  const items = await listTenantsLenient();
  const rules = parseHostRules(tenantHostEnv());

  return (
    <main>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-[20px] font-bold text-heading">事例</h1>
        <Link
          href="/admin/new"
          className="rounded-md bg-heading px-3 py-1.5 text-[13px] font-semibold text-card"
        >
          ＋ 新しい事例
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="text-[14px] text-muted">事例はまだありません。</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.slug} className="rounded-lg border border-line bg-card p-4">
              {item.record === null ? (
                <div className="text-[13px] text-body">
                  <p className="tabular font-bold text-heading">{item.slug}</p>
                  <p className="mt-1">設定が読めません。`tenant-upsert` で直してください。</p>
                  <p className="mt-1 text-muted">{item.error}</p>
                </div>
              ) : (
                <TenantRow rec={item.record} rules={rules} />
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function TenantRow({
  rec,
  rules,
}: {
  rec: TenantRecord;
  rules: ReturnType<typeof parseHostRules>;
}) {
  const s = rec.settings;
  const urls = publicUrls(rec.slug, rules);
  return (
    <div className="flex flex-col gap-1 text-[13px] text-body">
      <div className="flex items-baseline justify-between gap-3">
        <p>
          <span className="font-bold text-heading">{s.siteTitle}</span>{" "}
          <span className="tabular text-muted">{rec.slug}</span>
        </p>
        <Link href={`/admin/${rec.slug}`} className="shrink-0 underline hover:text-heading">
          編集
        </Link>
      </div>
      <p>
        {TYPE_LABEL[rec.type]} ・ {statusLabel(rec)}
      </p>
      <p className="tabular text-muted">
        監視期間 {isoDate(s.monitorStartAt)} 〜 {s.monitorEndDate}（JST）
      </p>
      {urls.map((u) => (
        <a key={u} href={u} className="tabular text-muted underline" target="_blank" rel="noreferrer">
          {u}
        </a>
      ))}
    </div>
  );
}
