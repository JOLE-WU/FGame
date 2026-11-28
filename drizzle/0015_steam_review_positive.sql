-- Switch the cached "score" column from Metacritic media score to Steam's
-- player review percentage. The two are different scales on the same games,
-- so every previously cached number is wrong under the new meaning: drop the
-- rows instead of silently mixing the two.
ALTER TABLE `steam_ratings` ADD COLUMN `review_count` integer;
DELETE FROM `steam_ratings`;
