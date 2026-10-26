import { describe, expect, it } from "vitest";
import type { CrossPost } from "./types";
import { crossChartAxis } from "./view";

function post(publishedAt: number): CrossPost {
  return {
    insightId: String(publishedAt),
    platform: "youtube",
    url: "https://example.com",
    stance: null,
    urgency: "NONE",
    claimType: "other",
    officialRelationship: "",
    officialUrl: null,
    claimSummary: "",
    publishedAt,
  };
}

describe("crossChartAxis", () => {
  it("1日ビンは JST の 00:00 に揃える", () => {
    // JST 09/13 08:00 は UTC では 09/12 23:00。UTC で丸めると前日 09:00 JST 始まりになる
    const axis = crossChartAxis(
      [post(Date.parse("2026-09-13T08:00:00+09:00")), post(Date.parse("2026-09-14T23:00:00+09:00"))],
      1440,
    );
    expect(axis).toEqual({
      startAt: Date.parse("2026-09-13T00:00:00+09:00"),
      binCount: 2,
      binMs: 24 * 60 * 60 * 1000,
    });
  });

  it("30分ビンは従来どおり30分境界に揃える", () => {
    const axis = crossChartAxis([post(Date.parse("2026-07-28T16:27:00+09:00"))], 30);
    expect(axis?.startAt).toBe(Date.parse("2026-07-28T16:00:00+09:00"));
    expect(axis?.binCount).toBe(1);
  });
});
