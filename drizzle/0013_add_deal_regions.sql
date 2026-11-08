-- iOS 限免多区：记录该 app 在哪些 App Store 区服当前价格核验为 0。
-- 逗号分隔国家码（cn,us,jp,in,hk）；历史空值由客户端按「国区」兜底。
ALTER TABLE deals ADD COLUMN regions TEXT;
