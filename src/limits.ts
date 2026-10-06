// Антиспам-лимиты на предложение вариантов. Настраиваются переменными окружения; 0 — без лимита.
// Модераторы языка и администраторы не ограничены (проверка — в POST /strings/:id/variants).
import { env } from './env.js';

const limitEnv = (name: string, def: number) => {
  const n = Number(env(name, String(def)));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
};

export const variantLimits = () => ({
  /** Своих вариантов у одной строки на одном языке */
  perUserString: limitEnv('VARIANTS_PER_USER_STRING', 3),
  /** Всего вариантов у строки на одном языке */
  perString: limitEnv('VARIANTS_PER_STRING', 30),
  /** Вариантов пользователя за последний час по всему сайту */
  perHour: limitEnv('VARIANTS_PER_HOUR', 500),
});
