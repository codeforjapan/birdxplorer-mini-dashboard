import { afterAll, describe, expect, it } from "vitest";
import { closePgPools, createPgSql } from "./pg-sql";

// 実 DB テストの土台なので、neon と同じ振る舞いをするかをここで押さえる
describe.skipIf(!process.env.TEST_DATABASE_URL)("pg アダプタ（実 DB）", () => {
  const sql = () => createPgSql(process.env.TEST_DATABASE_URL ?? "");

  afterAll(async () => {
    await closePgPools();
  });

  it("tagged template の値はパラメータとして渡り、配列は text[] になる", async () => {
    const rows = await sql()`select ${"a'b"}::text as s, ${["x", "y"]}::text[] as arr`;
    expect(rows).toEqual([{ s: "a'b", arr: ["x", "y"] }]);
  });

  it("transaction は途中で失敗すると全体をロールバックする", async () => {
    await sql().query("create table if not exists pg_sql_adapter_probe (v int primary key)");
    await sql().query("delete from pg_sql_adapter_probe");
    await expect(
      sql().transaction((txn) => [
        txn.query("insert into pg_sql_adapter_probe (v) values ($1)", [1]),
        txn`insert into pg_sql_adapter_probe (v) values (${1})`,
      ]),
    ).rejects.toThrow();
    expect(await sql()`select count(*)::int as n from pg_sql_adapter_probe`).toEqual([{ n: 0 }]);
    await sql().query("drop table pg_sql_adapter_probe");
  });

  it("transaction の分離レベル・読み取り専用指定が効く", async () => {
    const [[level], [ro]] = await sql().transaction(
      (txn) => [txn`show transaction_isolation`, txn`show transaction_read_only`],
      { isolationLevel: "RepeatableRead", readOnly: true },
    );
    expect(level).toEqual({ transaction_isolation: "repeatable read" });
    expect(ro).toEqual({ transaction_read_only: "on" });
  });
});
