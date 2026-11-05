-- マルチテナント化: tenants テーブルと、全テーブルへの tenant_id 追加。
--
-- 新しい（空の）DB 専用。既存行のあるテーブルに tenant_id（not null・既定値なし）を足すため、
-- 熊本・沖縄の既存 DB に流すと意図どおり失敗する（誤って流す事故を防ぐ）。
-- migrate() は適用済みを schema_migrations に記録して1回しか流さない。
-- 主キーとインデックスの付け替えはロックと負荷が大きいので、毎回流す設計にはしない。
-- 時刻は 001 に倣い epoch ミリ秒の bigint。

create table if not exists tenants (
  slug                   text primary key,
  type                   text not null,
  status                 text not null,
  settings               jsonb not null,
  overrides              jsonb not null default '{}',
  searchlight_stopped_at bigint,
  updated_at             bigint not null
);

alter table clusters                 add column if not exists tenant_id text not null references tenants (slug);
alter table notes                    add column if not exists tenant_id text not null references tenants (slug);
alter table retry_queue              add column if not exists tenant_id text not null references tenants (slug);
alter table job_runs                 add column if not exists tenant_id text not null references tenants (slug);
alter table app_state                add column if not exists tenant_id text not null references tenants (slug);
alter table searchlight_insights     add column if not exists tenant_id text not null references tenants (slug);
alter table searchlight_cross_posts  add column if not exists tenant_id text not null references tenants (slug);

-- 主キーを付け替える前に、clusters(id) を参照する外部キーを外す（参照先の主キーを落とせないため）。
alter table notes    drop constraint if exists notes_cluster_id_fkey;
alter table clusters drop constraint if exists clusters_alias_of_fkey;

alter table clusters                 drop constraint if exists clusters_pkey;
alter table notes                    drop constraint if exists notes_pkey;
alter table retry_queue              drop constraint if exists retry_queue_pkey;
alter table job_runs                 drop constraint if exists job_runs_pkey;
alter table app_state                drop constraint if exists app_state_pkey;
alter table searchlight_insights     drop constraint if exists searchlight_insights_pkey;
alter table searchlight_cross_posts  drop constraint if exists searchlight_cross_posts_pkey;

alter table clusters                 add primary key (tenant_id, id);
alter table notes                    add primary key (tenant_id, note_id);
alter table retry_queue              add primary key (tenant_id, note_id);
alter table job_runs                 add primary key (tenant_id, job);
alter table app_state                add primary key (tenant_id, key);
alter table searchlight_insights     add primary key (tenant_id, tweet_id);
alter table searchlight_cross_posts  add primary key (tenant_id, insight_id);

-- 別の事例のクラスタを参照できないよう、外部キーも tenant_id を含めて張り直す。
-- 参照列のどれかが null なら検査されない（cluster_id / alias_of は null 可なので従来どおり）。
alter table notes    add constraint notes_cluster_id_fkey    foreign key (tenant_id, cluster_id) references clusters (tenant_id, id);
alter table clusters add constraint clusters_alias_of_fkey   foreign key (tenant_id, alias_of)   references clusters (tenant_id, id);

drop index if exists notes_created_at_idx;
drop index if exists notes_visible_idx;
drop index if exists notes_cluster_idx;
create index notes_created_at_idx on notes (tenant_id, created_at);
create index notes_visible_idx    on notes (tenant_id, created_at) where excluded = false;
create index notes_cluster_idx    on notes (tenant_id, cluster_id) where cluster_id is not null;
