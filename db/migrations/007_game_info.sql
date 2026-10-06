-- Об игре: описание, ссылки (Steam, сайт издателя, GOG, itch.io…) и картинка-обложка для страницы игры.
alter table games
  add column description text,
  add column links jsonb not null default '[]',
  add column cover_url text;
