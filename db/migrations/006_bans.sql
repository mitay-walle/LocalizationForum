-- Баны: game_id = null — на всём форуме, иначе только в этой игре; until = null — бессрочно.
-- Забаненный может читать, но не предлагать, не голосовать, не удалять свои варианты, не создавать игры и не загружать файлы.
create table bans (
  id          bigserial primary key,
  user_id     bigint not null references users(id) on delete cascade,
  game_id     bigint references games(id) on delete cascade,
  reason      text not null default '',
  until       timestamptz,
  created_by  bigint references users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index bans_user_idx on bans (user_id);
create index bans_game_idx on bans (game_id);

-- Лимит «вариантов в час» считает варианты пользователя по времени создания
create index variants_author_created_idx on variants (author_id, created_at);
