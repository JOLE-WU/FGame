CREATE TABLE IF NOT EXISTS `steam_ratings` (
  `key` text PRIMARY KEY NOT NULL,
  `score` integer,
  `appid` text,
  `checked_at` integer NOT NULL
);
