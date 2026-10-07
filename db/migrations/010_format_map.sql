-- Форматы по файлам: формат выбирается по расширению файла.
-- games.format_map — {".xml": "rimworld", ".gpc": "gunpoint", ".png": "-"}: "-" — не переводить, копировать как есть;
--   необязательный ключ "*" — формат для остальных расширений. games.format остаётся форматом «по умолчанию»
--   (для совместимости: импорт из репо игры и подсказка для новых расширений).
-- source_files.format — каким форматом файл разобран (экспорт и проверки берут его, даже если карту потом поменяли).
-- source_files.data — байты файлов «как есть» (картинки и прочие непереводимые файлы), content у них пустой.
alter table games add column format_map jsonb not null default '{}';
alter table source_files
  add column format text,
  add column data bytea;

-- Существующие игры: все их файлы были разобраны games.format
update source_files sf set format = g.format from games g where g.id = sf.game_id;
update games g set format_map = coalesce((
  select jsonb_object_agg(e.ext, g.format)
  from (
    select distinct lower(substring(f.path from '[^/.][^/]*([.][^./]+)$')) as ext
    from (select path from source_files where game_id = g.id union select file from strings where game_id = g.id) f(path)
  ) e
  where e.ext is not null
), '{}');
