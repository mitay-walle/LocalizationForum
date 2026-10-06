-- Варианты, предложенные через MCP (ИИ-ассистентом), помечаются на сайте
alter table variants add column ai boolean not null default false;

-- Токены доступа к API/MCP: персональные (создаются на сайте) и выданные через OAuth.
-- Храним только sha256 токена.
create table api_tokens (
  id            bigserial primary key,
  user_id       bigint not null references users(id) on delete cascade,
  name          text not null,
  kind          text not null default 'personal',   -- personal | oauth
  client_id     text,
  token_hash    text unique not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz
);
create index api_tokens_user_idx on api_tokens (user_id);

-- OAuth 2.1: динамически зарегистрированные клиенты (Claude, Cursor…) и одноразовые коды
create table oauth_clients (
  client_id      text primary key,
  client_name    text,
  redirect_uris  text[] not null,
  created_at     timestamptz not null default now()
);

create table oauth_codes (
  code_hash       text primary key,
  client_id       text not null references oauth_clients(client_id) on delete cascade,
  user_id         bigint not null references users(id) on delete cascade,
  redirect_uri    text not null,
  code_challenge  text not null,
  expires_at      timestamptz not null
);
