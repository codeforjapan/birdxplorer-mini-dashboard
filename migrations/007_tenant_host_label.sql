-- 公開 URL のサブドメイン（settings.hostLabel）を slug から切り離す。
-- slug は変わらない識別子として DB と Blob に残し、URL だけを後から変えられるようにする。
-- 既存の事例はこれまでどおりの URL で見えるよう、slug と同じ値で埋める。
update tenants
set settings = settings || jsonb_build_object('hostLabel', slug)
where not settings ? 'hostLabel';

-- 同じラベルの事例が2つあると、どちらを表示するかが決まらない
create unique index if not exists tenants_host_label_idx on tenants ((settings->>'hostLabel'));
