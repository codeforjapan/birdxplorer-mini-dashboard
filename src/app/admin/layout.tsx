import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { adminRedirectTarget } from "@/lib/admin/host";
import { adminEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let origin: string;
  try {
    origin = adminEnv().ADMIN_ORIGIN;
  } catch {
    // 設定が無いまま開けるホストを作らない
    return (
      <main className="mx-auto w-full max-w-md px-4 py-16 text-body">
        <h1 className="text-[20px] font-bold text-heading">管理画面は設定されていません</h1>
        <p className="mt-3 text-[14px] leading-[1.7]">
          環境変数 ADMIN_ORIGIN（例: https://admin.example.com）が未設定か不正です。設定してから開き直してください。
        </p>
      </main>
    );
  }
  const target = adminRedirectTarget((await headers()).get("host"), "/admin", origin);
  if (target) redirect(target);
  return <>{children}</>;
}
