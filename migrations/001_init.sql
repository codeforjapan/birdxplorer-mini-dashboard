-- コミュニティノートタイムライン 令和8年熊本地震 — 初期スキーマ
--
-- Neon Postgres がノート・クラスタ・状態すべての唯一の真実である。
-- Vercel Blob はここから書き出される公開用スナップショットであり、読み戻さない
-- （Blob は上書き後 CDN 伝播に最大60秒かかるため、read-modify-write の土台にはできない）。
--
-- 時刻はすべて epoch ミリ秒の bigint で持つ。BirdXplorer API が epoch ms を返すため、
-- 境界での変換を1箇所（データ層）に閉じ込める意図。
-- Postgres の bigint はドライバ上で文字列になるので、読み出し時に必ず数値へ変換する。

-- notes が参照するため先に作る。
create table if not exists clusters (
  id          text primary key,
  name        text not null,
  description text not null,
  -- パレット添字（0-9）。採番後は変更しない。
  color_index integer not null,
  created_at  bigint not null,
  -- マージ先。非null ならこのクラスタは吸収済み。行は削除しない
  -- （IDを振り直すと時系列グラフの色分けが毎回ジャンプして履歴が読めなくなる）。
  alias_of    text references clusters (id)
);

create table if not exists notes (
  note_id  text primary key,
  post_id  text not null,
  created_at bigint not null,
  -- ノート本文。公開サイトに表示する。
  summary  text not null,
  -- Xポストへのリンク。post_id のみから組み立てる（`https://x.com/user/status/{post_id}`）。
  -- API の post.link は投稿者の表示名を URL に含むため使わない（src/lib/birdxplorer.ts 参照）。
  post_url text not null,

  -- ── 評価状態（refresh-status ジョブで定期更新）──
  -- API が新しい値を返しても取り込めるよう、あえて CHECK 制約を置かない。
  current_status      text,
  helpful_count       integer not null default 0,
  not_helpful_count   integer not null default 0,
  rate_count          integer not null default 0,
  -- /api/v1/data/notes に post が含まれないため、この値は ingest 時の初回値で固定される。
  impression_count    bigint,
  status_refreshed_at bigint not null,

  -- ── 分類結果 ──
  relevance          integer not null,
  -- relevance < RELEVANCE_THRESHOLD。除外しても行は消さない（閾値チューニングの検証に使う）。
  excluded           boolean not null,
  exclude_reason     text,
  cluster_id         text references clusters (id),
  classified_at      bigint not null,
  -- プロンプト改訂時に再分類対象を判定するため。
  classifier_version text not null
);

-- タイムライン集計と日次ダイジェストの範囲抽出用。
create index if not exists notes_created_at_idx on notes (created_at);
-- 公開ビューは除外ノートを読まない。
create index if not exists notes_visible_idx on notes (created_at) where excluded = false;
create index if not exists notes_cluster_idx on notes (cluster_id) where cluster_id is not null;

-- カーソルなどの小さな状態。キーは docs/spec.md §5.1 の名前を踏襲する。
create table if not exists app_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- LLM出力のパース失敗ノートの再試行キュー。
create table if not exists retry_queue (
  note_id     text primary key,
  enqueued_at bigint not null,
  attempts    integer not null default 0,
  reason      text
);

-- 各ジョブの最終実行のみ保持する（履歴は Vercel のランタイムログ側に残る）。
create table if not exists job_runs (
  job         text primary key,
  started_at  bigint not null,
  finished_at bigint not null,
  ok          boolean not null,
  stats       jsonb not null,
  error       text
);
