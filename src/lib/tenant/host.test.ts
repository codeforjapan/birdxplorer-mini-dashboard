import { describe, expect, it, vi } from "vitest";
import { parseHostRules, resolveSlugFromHost } from "./host";

const rules = {
  parentDomain: "dashboards.code4japan.org",
  aliases: { "kumamoto-earthquake-cninfo.vercel.app": "kumamoto" },
};

describe("resolveSlugFromHost", () => {
  it("親ドメイン直下1階層を slug とみなす", () => {
    expect(resolveSlugFromHost("okinawa2026.dashboards.code4japan.org", rules)).toBe("okinawa2026");
  });

  it("大文字・ポート付きでも同じ事例に解決する", () => {
    expect(resolveSlugFromHost("OKINAWA2026.Dashboards.Code4Japan.org", rules)).toBe("okinawa2026");
    expect(resolveSlugFromHost("okinawa2026.dashboards.code4japan.org:443", rules)).toBe("okinawa2026");
  });

  it("別名のホストは対応表で引く", () => {
    expect(resolveSlugFromHost("kumamoto-earthquake-cninfo.vercel.app", rules)).toBe("kumamoto");
    expect(resolveSlugFromHost("Kumamoto-Earthquake-Cninfo.vercel.app:3000", rules)).toBe("kumamoto");
  });

  it("既定の事例に落とさず null を返す", () => {
    expect(resolveSlugFromHost("dashboards.code4japan.org", rules)).toBeNull();
    expect(resolveSlugFromHost("a.b.dashboards.code4japan.org", rules)).toBeNull();
    expect(resolveSlugFromHost("www.dashboards.code4japan.org", rules)).toBeNull();
    expect(resolveSlugFromHost("evil.com", rules)).toBeNull();
    expect(resolveSlugFromHost("x.dashboards.code4japan.org.evil.com", rules)).toBeNull();
    expect(resolveSlugFromHost("xdashboards.code4japan.org", rules)).toBeNull();
    expect(resolveSlugFromHost("-bad.dashboards.code4japan.org", rules)).toBeNull();
    expect(resolveSlugFromHost("", rules)).toBeNull();
    expect(resolveSlugFromHost(null, rules)).toBeNull();
  });

  it("親ドメイン未設定なら別名だけで引く", () => {
    const aliasOnly = { parentDomain: null, aliases: { localhost: "demo" } };
    expect(resolveSlugFromHost("localhost:3000", aliasOnly)).toBe("demo");
    expect(resolveSlugFromHost("okinawa2026.dashboards.code4japan.org", aliasOnly)).toBeNull();
  });
});

describe("parseHostRules", () => {
  it("壊れた設定で落ちない", () => {
    expect(parseHostRules({ TENANT_HOST_ALIASES: "not json" })).toEqual({ parentDomain: null, aliases: {} });
    expect(parseHostRules({ TENANT_HOST_ALIASES: "[1,2]" })).toEqual({ parentDomain: null, aliases: {} });
    expect(parseHostRules({})).toEqual({ parentDomain: null, aliases: {} });
  });

  it("ホストを小文字化し、slug 規則に合わない別名を捨てる", () => {
    expect(
      parseHostRules({
        TENANT_PARENT_DOMAIN: " Dashboards.Code4Japan.org ",
        TENANT_HOST_ALIASES: JSON.stringify({ "Kumamoto.Vercel.App": "kumamoto", "x.example": "../etc", y: 1 }),
      }),
    ).toEqual({ parentDomain: "dashboards.code4japan.org", aliases: { "kumamoto.vercel.app": "kumamoto" } });
  });

  it("空の親ドメインは未設定として扱う", () => {
    expect(parseHostRules({ TENANT_PARENT_DOMAIN: "" }).parentDomain).toBeNull();
  });
});

describe("parseHostRules の警告", () => {
  // 警告済みの印はモジュールに1つなので、テストごとに読み込み直す
  async function fresh(): Promise<typeof import("./host")> {
    vi.resetModules();
    return import("./host");
  }

  it("捨てた設定をインスタンスにつき1回だけログに出す", async () => {
    const { parseHostRules: parse } = await fresh();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    parse({ TENANT_PARENT_DOMAIN: "p.example", TENANT_HOST_ALIASES: JSON.stringify({ "x.example": "../etc" }) });
    parse({ TENANT_HOST_ALIASES: "not json" });
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[0])).toContain("x.example");
    error.mockRestore();
  });

  it("壊れた JSON・親ドメイン未設定を伝える", async () => {
    const { parseHostRules: parse } = await fresh();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    parse({ TENANT_HOST_ALIASES: "not json" });
    const msg = String(error.mock.calls[0]?.[0]);
    expect(msg).toContain("TENANT_PARENT_DOMAIN");
    expect(msg).toContain("JSON");
    error.mockRestore();
  });

  it("正しい設定なら何も出さない", async () => {
    const { parseHostRules: parse } = await fresh();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    parse({ TENANT_PARENT_DOMAIN: "p.example", TENANT_HOST_ALIASES: JSON.stringify({ "a.example": "a" }) });
    parse({ TENANT_PARENT_DOMAIN: "p.example" });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
