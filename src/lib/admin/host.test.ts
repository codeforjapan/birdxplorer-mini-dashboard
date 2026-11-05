import { describe, expect, it } from "vitest";
import { adminRedirectTarget, isAdminHost } from "./host";

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

describe("isAdminHost", () => {
  it("ADMIN_ORIGIN のホストだけ真（大文字違いも同じ扱い）", () => {
    expect(isAdminHost("a.vercel.app", "https://a.vercel.app")).toBe(true);
    expect(isAdminHost("A.Vercel.App", "https://a.vercel.app")).toBe(true);
    expect(isAdminHost("x.vercel.app", "https://a.vercel.app")).toBe(false);
    expect(isAdminHost(null, "https://a.vercel.app")).toBe(false);
  });

  it("ADMIN_ORIGIN が未設定・不正でも例外にせず偽", () => {
    expect(isAdminHost("a.vercel.app", undefined)).toBe(false);
    expect(isAdminHost("a.vercel.app", "not a url")).toBe(false);
  });
});
