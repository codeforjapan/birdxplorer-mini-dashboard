-- Searchlight の X insight を tweet_id で保持する取り込みテーブル。
-- notes.post_id と 1:1 で結合し、公開スナップショット生成時にノートへバッジを付与する。
-- 非永続ルール: post 本文・投稿者・AI 自由文は入れない。列挙値と公式(公開情報)URL のみ。
-- 時刻は 001 に倣い epoch ミリ秒の bigint。
create table if not exists searchlight_insights (
  tweet_id                      text primary key,
  stance                        text not null,   -- SPREADING | DEBUNKING | REPORTING | NEUTRAL
  urgency                       text not null,   -- NONE | LOW | MEDIUM | HIGH
  claim_type                    text not null,
  official_source_relationship  text not null,
  official_source_url           text,            -- 公式URL。無ければ null
  synced_at                     bigint not null
);
