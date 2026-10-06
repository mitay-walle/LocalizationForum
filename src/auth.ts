import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Context } from 'hono';
import { db } from './db.js';
import { env, list } from './env.js';

export interface User {
  id: number;
  login: string;
  avatar_url: string | null;
  is_admin: boolean;
}

const key = () => new TextEncoder().encode(env('JWT_SECRET'));

export async function signSession(userId: number): Promise<string> {
  return new SignJWT({ typ: 'session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key());
}

export async function signState(returnTo: string): Promise<string> {
  return new SignJWT({ typ: 'oauth-state', ret: returnTo })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('10m')
    .sign(key());
}

export async function verifyState(state: string): Promise<string> {
  const { payload } = await jwtVerify(state, key());
  if (payload.typ !== 'oauth-state' || typeof payload.ret !== 'string') throw new Error('bad state');
  return payload.ret;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Выпустить токен API/MCP. Возвращает сам токен — показать один раз, в БД только хеш. */
export async function createApiToken(userId: number, name: string, kind: 'personal' | 'oauth', clientId: string | null = null, days?: number) {
  const token = 'lf_' + randomBytes(24).toString('base64url');
  const [row] = await db()<{ id: number }[]>`
    insert into api_tokens (user_id, name, kind, client_id, token_hash, expires_at)
    values (${userId}, ${name.slice(0, 100)}, ${kind}, ${clientId}, ${sha256(token)},
            ${days ? new Date(Date.now() + days * 864e5) : null})
    returning id`;
  return { id: row.id, token };
}

/** Пользователь по токену API (lf_…). Обновляет last_used_at не чаще раза в минуту. */
export async function userByApiToken(token: string): Promise<User | null> {
  const [u] = await db()<(User & { token_id: number })[]>`
    select u.id, u.login, u.avatar_url, u.is_admin, t.id as token_id
    from api_tokens t join users u on u.id = t.user_id
    where t.token_hash = ${sha256(token)} and (t.expires_at is null or t.expires_at > now())`;
  if (!u) return null;
  await db()`update api_tokens set last_used_at = now()
    where id = ${u.token_id} and (last_used_at is null or last_used_at < now() - interval '1 minute')`;
  const { token_id: _t, ...user } = u;
  return user;
}

/** Текущий пользователь: Authorization: Bearer <сессия сайта | токен lf_…>. */
export async function currentUser(c: Context): Promise<User | null> {
  const h = c.req.header('authorization');
  if (!h?.startsWith('Bearer ')) return null;
  if (h.slice(7).startsWith('lf_')) return userByApiToken(h.slice(7));
  try {
    const { payload } = await jwtVerify(h.slice(7), key());
    if (payload.typ !== 'session' || !payload.sub) return null;
    const [u] = await db()<User[]>`select id, login, avatar_url, is_admin from users where id = ${Number(payload.sub)}`;
    return u ?? null;
  } catch {
    return null;
  }
}

/** Создать/обновить пользователя после входа через GitHub. */
export async function upsertUser(gh: { id: number; login: string; avatar_url?: string }): Promise<User> {
  const admin = list('ADMIN_LOGINS').some((l) => l.toLowerCase() === gh.login.toLowerCase());
  const [u] = await db()<User[]>`
    insert into users (github_id, login, avatar_url, is_admin)
    values (${gh.id}, ${gh.login}, ${gh.avatar_url ?? null}, ${admin})
    on conflict (github_id) do update
      set login = excluded.login,
          avatar_url = excluded.avatar_url,
          is_admin = users.is_admin or excluded.is_admin
    returning id, login, avatar_url, is_admin`;
  return u;
}

export async function isModerator(user: User | null, gameId: number, lang: string): Promise<boolean> {
  if (!user) return false;
  if (user.is_admin) return true;
  const rows = await db()`
    select 1 from moderators
    where game_id = ${gameId} and user_id = ${user.id} and (lang = ${lang} or lang = '*')
    limit 1`;
  return rows.length > 0;
}

/** Разрешён ли адрес возврата после входа (защита от открытого редиректа). */
export function allowedReturn(url: string, requestUrl: string): boolean {
  try {
    const u = new URL(url);
    const origins = [...list('SITE_ORIGINS'), new URL(requestUrl).origin];
    return origins.includes(u.origin);
  } catch {
    return false;
  }
}
