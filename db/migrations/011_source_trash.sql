-- Корзина удалённых оригиналов: удалённый файл можно вернуть (POST /games/:slug/source/restore) в течение 30 дней.
-- Строки удалённого файла помечаются removed (как при пропаже файла из полной загрузки) — варианты и утверждения
-- остаются в БД и возвращаются вместе с файлом. Старше 30 дней — чистятся при следующем удалении.
create table source_files_trash (
  game_id     bigint not null references games(id) on delete cascade,
  path        text not null,
  content     text not null,
  encoding    text not null default 'utf-8',
  format      text,
  data        bytea,
  deleted_by  bigint references users(id) on delete set null,
  deleted_at  timestamptz not null default now(),
  primary key (game_id, path)
);
create index source_files_trash_deleted_idx on source_files_trash (deleted_at);
