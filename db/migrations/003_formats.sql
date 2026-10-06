-- Пользовательские построчные форматы (конфиг — JSON, см. src/formats/lines.ts)
create table custom_formats (
  slug        text primary key,
  title       text not null,
  config      jsonb not null,
  created_by  bigint references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Оригиналы файлов для форматов, где перевод собирается поверх исходника (все построчные форматы)
create table source_files (
  game_id     bigint not null references games(id) on delete cascade,
  path        text not null,
  content     text not null,
  updated_at  timestamptz not null default now(),
  primary key (game_id, path)
);
