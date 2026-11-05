import { NextResponse, type NextRequest } from "next/server";
import { tenantHostEnv } from "@/lib/env";
import { parseHostRules, resolveSlugFromHost } from "@/lib/tenant/host";

/**
 * ホスト名で事例を引き、公開ページを /t/{slug} 配下に書き換える。
 * 引けないホストは既定の事例に落とさず 404 にする（別の事例が表示されるのを防ぐ）。
 * パスは書き換え先の後ろに付けるだけなので、/t/other/... と直接叩いても他の事例には届かない。
 */
export function proxy(request: NextRequest) {
  const slug = resolveSlugFromHost(request.headers.get("host"), parseHostRules(tenantHostEnv()));
  if (!slug) return new NextResponse("Not Found", { status: 404 });

  const url = request.nextUrl.clone();
  url.pathname = `/t/${slug}${url.pathname === "/" ? "" : url.pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  // API・Next の内部・管理画面・拡張子付きの静的ファイルは事例を経由しない
  matcher: ["/((?!api/|_next/|admin|.*\\..*).*)"],
};
