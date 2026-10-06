-- Этап перевода для пары «игра + язык»:
--   open   — групповой перевод: все предлагают варианты и голосуют
--   review — апрув: предложения и голоса закрыты, модераторы утверждают
--   done   — готово: перевод заморожен (чтобы править — вернуть на другой этап)
create table language_status (
  game_id     bigint not null references games(id) on delete cascade,
  lang        text not null,
  status      text not null default 'open' check (status in ('open', 'review', 'done')),
  updated_by  bigint references users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (game_id, lang)
);
