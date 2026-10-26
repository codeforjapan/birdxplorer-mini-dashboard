import { describe, expect, it } from "vitest";
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
