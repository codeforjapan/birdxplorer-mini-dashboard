import { describe, expect, it } from "vitest";
import { pendingMigrations, splitStatements } from "./migrations";

describe("pendingMigrations", () => {
  it("適用済みを除き、ファイル名の辞書順で返す", () => {
    const files = ["003_c.sql", "001_a.sql", "002_b.sql", "README.md"];
    expect(pendingMigrations(files, new Set(["001_a.sql"]))).toEqual(["002_b.sql", "003_c.sql"]);
  });

  it("全て適用済みなら空（2回目の migrate() は何も流さない）", () => {
    const files = ["001_a.sql", "002_b.sql"];
    expect(pendingMigrations(files, new Set(files))).toEqual([]);
  });

  it("途中が欠けていても未適用のものは名前順で返す", () => {
    const files = ["001_a.sql", "002_b.sql", "003_c.sql"];
    expect(pendingMigrations(files, new Set(["002_b.sql"]))).toEqual(["001_a.sql", "003_c.sql"]);
  });
});

describe("splitStatements", () => {
  it("コメント行を除いて ; で分割し、空文を捨てる", () => {
    const text = "-- 説明\ncreate table a (id int);\n\n-- 次\nalter table a add column b int;\n";
    expect(splitStatements(text)).toEqual(["create table a (id int)", "alter table a add column b int"]);
  });
});
