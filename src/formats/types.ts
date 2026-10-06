/** Строка, извлечённая из файла игры. */
export interface ParsedString {
  key: string;
  source: string;
  context?: string;
}

/** Строка для записи перевода обратно в файл. */
export interface OutString {
  key: string;
  source: string;
  text: string;
}

export interface Format {
  id: string;
  /**
   * Файл нельзя собрать только из строк (например, номера строк — это ссылки переходов).
   * Тогда форум хранит оригинал файла целиком, а serialize получает его и ВСЕ строки файла
   * (непереведённые — с текстом оригинала).
   */
  skeleton?: boolean;
  /** Дополнительные проверки текста перевода, специфичные для формата. */
  validate?(text: string): string[];
  /** Какие файлы из source/ этот формат забирает (путь с прямыми слэшами, относительно source/). */
  matches(path: string): boolean;
  parse(path: string, content: string): ParsedString[];
  serialize(path: string, strings: OutString[], original?: string): string;
}
