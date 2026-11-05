import { notFound } from "next/navigation";
import { ensureMigrated } from "@/app/api/cron/_lib/migrate-once";
import { formValuesFromRecord } from "@/lib/admin/form";
import { requireAdminOrRedirect } from "@/lib/admin/session";
import { getTenant } from "@/lib/tenant/repo";
import { isValidSlug } from "@/lib/tenant/slug";
import type { TenantRecord } from "@/lib/tenant/types";
import { EditTenantForm } from "./EditTenantForm";

export const dynamic = "force-dynamic";

export default async function EditTenantPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireAdminOrRedirect();
  const { slug } = await params;
  if (!isValidSlug(slug)) notFound();
  await ensureMigrated();

  let rec: TenantRecord | null;
  try {
    rec = await getTenant(slug);
  } catch (e) {
    console.error(`[admin] 既存の事例が読めません: ${slug}`, e);
    return (
      <main>
        <p className="tabular font-bold text-heading">{slug}</p>
        <p className="mt-2 text-[14px] text-body">
          設定が読めません。<code>tenant-upsert</code> で直してください。
        </p>
      </main>
    );
  }
  if (rec === null) notFound();

  return (
    <main>
      <EditTenantForm
        initial={formValuesFromRecord(rec)}
        initialStatus={rec.status}
        initialUpdatedAt={rec.updatedAt}
        searchlightTopicId={rec.settings.searchlightTopicId}
      />
    </main>
  );
}
