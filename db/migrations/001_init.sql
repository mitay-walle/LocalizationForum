-- Пользователи (вход только через GitHub)
create table users (
  id          bigserial primary key,
  github_id   bigint unique not null,
  login       text not null,
  avatar_url  text,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index users_login_idx on users (lower(login));

-- Игры (одна игра = один репо, языки в папках)
create table games (
  id           bigserial primary key,
  slug         text unique not null,
  title        text not null,
  repo         text,                         -- owner/name
  format       text not null,                -- json | json-nested | rimworld
  source_lang  text not null default 'en',
  languages    text[] not null default '{}',
  rules        jsonb not null default '{}',  -- { "ru": [ {pattern, flags?, message, level} ] }
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Исходные строки. Ключ уникален в пределах файла.
create table strings (
  id           bigserial primary key,
  game_id      bigint not null references games(id) on delete cascade,
  file         text not null,               -- путь относительно source/
  key          text not null,
  source       text not null,
  context      text,
  source_hash  text not null,
  position     int not null default 0,      -- порядок в файле
  removed      boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (game_id, file, key)
);
create index strings_game_file_idx on strings (game_id, file, position);

-- Предложенные варианты перевода
create table variants (
  id          bigserial primary key,
  string_id   bigint not null references strings(id) on delete cascade,
  lang        text not null,
  text        text not null,
  author_id   bigint references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (string_id, lang, text)
);
create index variants_string_lang_idx on variants (string_id, lang);

-- Голоса: один пользователь — один голос за вариант
create table votes (
  variant_id  bigint not null references variants(id) on delete cascade,
  user_id     bigint not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (variant_id, user_id)
);

-- Утверждённый перевод строки на язык
create table approved (
  string_id     bigint not null references strings(id) on delete cascade,
  lang          text not null,
  text          text not null,
  variant_id    bigint references variants(id) on delete set null,
  source_hash   text not null,               -- если отличается от strings.source_hash — перевод устарел
  moderator_id  bigint references users(id) on delete set null,
  approved_at   timestamptz not null default now(),
  primary key (string_id, lang)
);

-- Модераторы игры. lang = '*' — все языки игры.
create table moderators (
  game_id  bigint not null references games(id) on delete cascade,
  lang     text not null,
  user_id  bigint not null references users(id) on delete cascade,
  primary key (game_id, lang, user_id)
);

-- Когда последний раз дёргали repository_dispatch (антидребезг)
alter table games add column dispatched_at timestamptz;
