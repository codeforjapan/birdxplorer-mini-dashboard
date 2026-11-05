import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { shouldUseMock } from "@/lib/mock";
import { readPublicTenant } from "@/lib/tenant/publish";

/**
 * 事例の有無はここで決める。ページは loading.tsx の Suspense の内側にあり、そこで notFound() しても
 * 200 のヘッダーを送った後なので、画面だけ「見つかりません」でステータスは 200 のままになる。
 * layout は Suspense より外側なので、ここで notFound() すれば 404 を返せる。
 */
export default async function TenantLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ label: string }>;
}) {
  // layout は searchParams を受け取れないので、?mock=1 を使える環境（本番以外）ではページの判定に任せる
  if (!shouldUseMock("1")) {
    const { label } = await params;
    // 読み取り失敗は 404 にせず例外のまま返す（404 が ISR にキャッシュされるため。page.tsx と同じ）
    const tenant = await readPublicTenant(label);
    if (!tenant || tenant.config.status === "draft") notFound();
  }
  return children;
}
