-- 非X insight のエンゲージメント指標を searchlight_cross_posts に追加する。
-- 数値集計のみで個人特定情報ではない（著者・本文は引き続き保存しない）。
-- 指標は youtube/tiktok を中心に取得でき、無いPF（web は全欠落・threads は likes のみ）では null。
-- migrate() は全 .sql を毎回流す（db.ts）ため、既存テーブルにも安全に足せるよう add column if not exists を使う。
-- 炎上レートは Searchlight 算出の生値（0〜1）。式が PF で異なる（youtube=comments/views, tiktok=comments/likes）。
alter table searchlight_cross_posts add column if not exists views      bigint;
alter table searchlight_cross_posts add column if not exists likes      bigint;
alter table searchlight_cross_posts add column if not exists comments   bigint;
alter table searchlight_cross_posts add column if not exists shares     bigint;
alter table searchlight_cross_posts add column if not exists collects   bigint;
alter table searchlight_cross_posts add column if not exists flame_rate double precision;
