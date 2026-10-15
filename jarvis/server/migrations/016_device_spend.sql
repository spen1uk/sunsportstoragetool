ALTER TABLE llm_usage ADD COLUMN channel TEXT;
ALTER TABLE llm_usage ADD COLUMN device_id TEXT;
CREATE INDEX llm_usage_device ON llm_usage(device_id, at);
ALTER TABLE devices ADD COLUMN monthly_limit_micro_usd INTEGER NOT NULL DEFAULT 10000000;
