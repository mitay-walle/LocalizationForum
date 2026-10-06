import { defineConfig } from 'vitest/config';

// Интеграционные тесты делят одну тестовую базу — файлы запускаем по очереди.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], fileParallelism: false } });
