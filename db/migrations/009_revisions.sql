-- Ревизии перевода (игра + язык). «Новая ревизия» снимает все утверждения языка: они уходят в approved_history
-- с номером ревизии, тексты остаются вариантами, а revision увеличивается.
alter table language_status add column revision int not null default 1;

create table approved_history (
  id            bigserial primary key,
  game_id       bigint not null references games(id) on delete cascade,
  lang          text not null,
  revision      int not null,
  string_id     bigint not null references strings(id) on delete cascade,
  text          text not null,
  variant_id    bigint references variants(id) on delete set null,
  source_hash   text not null,
  moderator_id  bigint references users(id) on delete set null,
  approved_at   timestamptz,
  archived_at   timestamptz not null default now()
);
create index approved_history_rev_idx on approved_history (game_id, lang, revision);
create index approved_history_string_idx on approved_history (string_id, lang);
