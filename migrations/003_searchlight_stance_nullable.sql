-- stance は分析が付与しないことがある（実データで stance=null の有用な insight を確認）。
-- stance 無しでも urgency/公式情報で価値があるため、NOT NULL 制約を外して格納できるようにする。
alter table searchlight_insights alter column stance drop not null;
