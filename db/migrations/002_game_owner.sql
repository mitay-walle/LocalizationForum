-- Кто создал игру через сайт (владелец получает права модератора на все языки)
alter table games add column created_by bigint references users(id) on delete set null;
