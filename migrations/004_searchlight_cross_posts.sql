-- 非X（youtube/tiktok/threads/web）の Searchlight 分析結果。
-- コミュニティノートに紐づかないため独立セクションで一覧表示する。
-- 非永続ルール: 投稿本文・著者は保存しない。列挙値・AI要約(claim_summary)・URL のみ。
create table if not exists searchlight_cross_posts (
  insight_id                    text primary key,
  platform                      text not null,
  url                           text not null,
  stance                        text,
  urgency                       text not null,
  claim_type                    text not null,
  official_source_relationship  text not null,
  official_source_url           text,
  claim_summary                 text not null,
  published_at                  bigint,
  synced_at                     bigint not null
);
