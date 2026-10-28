import { describe, expect, it } from "vitest";
import { adminRedirectTarget } from "./host";

describe("adminRedirectTarget", () => {
  const origin = "https://a.vercel.app";

  it("ホストが違えば ADMIN_ORIGIN の同じパスへ", () => {
    expect(adminRedirectTarget("x.vercel.app", "/admin", origin)).toBe("https://a.vercel.app/admin");
  });

  it("同じホストなら null（大文字違いも同じ扱い）", () => {
    expect(adminRedirectTarget("a.vercel.app", "/admin", origin)).toBeNull();
    expect(adminRedirectTarget("A.Vercel.App", "/admin", origin)).toBeNull();
  });

  it("ポートも比較する", () => {
    expect(adminRedirectTarget("localhost:3000", "/admin", "http://localhost:3000")).toBeNull();
    expect(adminRedirectTarget("localhost:3001", "/admin", "http://localhost:3000")).toBe(
      "http://localhost:3000/admin",
    );
  });

  it("host が無ければ ADMIN_ORIGIN へ", () => {
    expect(adminRedirectTarget(null, "/admin", origin)).toBe("https://a.vercel.app/admin");
  });
});
