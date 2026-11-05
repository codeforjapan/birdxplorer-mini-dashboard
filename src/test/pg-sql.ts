import pg from "pg";

/**
 * テスト専用: neon() の代わりに素の Postgres（node-postgres）へ繋ぐアダプタ。
 *
 * neon() は Neon の HTTP エンドポイントにしか話せないため、ローカルの使い捨て Postgres で
 * 実 DB テストを回すには差し替えが要る。db.ts の本番挙動は変えず、テスト側で
 * `@neondatabase/serverless` の neon をこれに置き換える（db.ts の sql()・migrate() は実物のまま動く）。
 *
 * 再現するのはこのコードベースが使う部分だけ: tagged template / query(text, params) が行配列を返すこと、
 * transaction(txn => [...]) が1つの BEGIN/COMMIT で流れて失敗時にロールバックされること。
 * bigint が文字列・jsonb がパース済みで返る点は pg の既定と neon で一致している。
 */

type Row = Record<string, unknown>;
type Pending = { text: string; params: unknown[] };

type TxnOptions = {
  isolationLevel?: "ReadUncommitted" | "ReadCommitted" | "RepeatableRead" | "Serializable";
  readOnly?: boolean;
  deferrable?: boolean;
};

type TxnBuilder = {
  (strings: TemplateStringsArray, ...values: unknown[]): Pending;
  query(text: string, params?: unknown[]): Pending;
};

export type PgSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  query(text: string, params?: unknown[]): Promise<Row[]>;
  transaction(build: (txn: TxnBuilder) => Pending[], opts?: TxnOptions): Promise<Row[][]>;
};

const pools = new Map<string, pg.Pool>();

function poolFor(url: string): pg.Pool {
  let pool = pools.get(url);
  if (pool === undefined) {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    pools.set(url, pool);
  }
  return pool;
}

function fromTemplate(strings: TemplateStringsArray, values: unknown[]): Pending {
  const text = strings.reduce((acc, s, i) => (i === 0 ? s : `${acc}$${i}${s}`), "");
  return { text, params: values };
}

const ISOLATION: Record<NonNullable<TxnOptions["isolationLevel"]>, string> = {
  ReadUncommitted: "read uncommitted",
  ReadCommitted: "read committed",
  RepeatableRead: "repeatable read",
  Serializable: "serializable",
};

function beginStatement(opts: TxnOptions | undefined): string {
  const modes: string[] = [];
  if (opts?.isolationLevel) modes.push(`isolation level ${ISOLATION[opts.isolationLevel]}`);
  if (opts?.readOnly) modes.push("read only");
  if (opts?.deferrable) modes.push("deferrable");
  return ["begin", modes.join(", ")].filter(Boolean).join(" ");
}

export function createPgSql(url: string): PgSql {
  const pool = poolFor(url);
  const run = async (p: Pending): Promise<Row[]> => (await pool.query<Row>(p.text, p.params)).rows;

  const txn: TxnBuilder = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => fromTemplate(strings, values),
    { query: (text: string, params: unknown[] = []): Pending => ({ text, params }) },
  );

  return Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => run(fromTemplate(strings, values)), {
    query: (text: string, params: unknown[] = []) => run({ text, params }),
    transaction: async (build: (t: TxnBuilder) => Pending[], opts?: TxnOptions): Promise<Row[][]> => {
      const queries = build(txn);
      const client = await pool.connect();
      try {
        await client.query(beginStatement(opts));
        const results: Row[][] = [];
        for (const q of queries) results.push((await client.query<Row>(q.text, q.params)).rows);
        await client.query("commit");
        return results;
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },
  });
}

export async function closePgPools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}
