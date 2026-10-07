-- Кодировки файлов игры.
-- source_files.encoding — кодировка, в которой был загружен оригинал (определяется в браузере по байтам, можно указать вручную).
-- games.encodings — {язык: кодировка} для выгрузки перевода; языка нет в объекте — «как в оригинале» (кодировка каждого файла).
-- games.source_encoding — самая частая кодировка оригиналов (для информации).
alter table source_files add column encoding text not null default 'utf-8';
alter table games
  add column encodings jsonb not null default '{}',
  add column source_encoding text;
