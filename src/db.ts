import postgres from 'postgres';
import { env } from './env.js';

let client: postgres.Sql | undefined;

/** Один пул на инстанс функции. prepare:false — для pooled-подключения Neon (pgbouncer). */
export function db(): postgres.Sql {
  if (!client) {
    client = postgres(env('DATABASE_URL'), {
      max: Number(process.env.DB_POOL_MAX ?? 3),
      prepare: false,
      idle_timeout: 20,
      onnotice: () => {},
      // bigint (bigserial id, count) отдаём числом: до 2^53 нам хватит с запасом
      types: { bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) } },
    });
  }
  return client;
}

export async function closeDb() {
  await client?.end({ timeout: 5 });
  client = undefined;
}
