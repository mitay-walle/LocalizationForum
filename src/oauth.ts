// OAuth 2.1 для MCP-клиентов (Claude, Cursor…) + персональные токены API.
//
// Поток: клиент регистрируется (DCR) → /api/oauth/authorize → вход через GitHub →
// страница согласия → одноразовый код → /api/oauth/token (PKCE S256) → токен lf_…
// Токен — обычный токен API: им же можно пользоваться в REST.
import { randomBytes, createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { SignJWT, jwtVerify } from 'jose';
import { createApiToken, currentUser, sha256 } from './auth.js';
import { db } from './db.js';
import { env } from './env.js';

const key = () => new TextEncoder().encode(env('JWT_SECRET'));
const fail = (status: 400 | 401 | 403 | 404, message: string): never => {
  throw new HTTPException(status, { message });
};
export const origin = (c: Context) => new URL(c.req.url).origin;
const b64url = (buf: Buffer) => buf.toString('base64url');

/** Метаданные: какие серверы авторизации защищают ресурс (RFC 9728). */
export function protectedResourceMetadata(c: Context) {
  const o = origin(c);
  return { resource: `${o}/api/mcp`, authorization_servers: [o], bearer_methods_supported: ['header'], scopes_supported: ['forum'] };
}

/** Метаданные сервера авторизации (RFC 8414). */
export function authServerMetadata(c: Context) {
  const o = origin(c);
  return {
    issuer: o,
    authorization_endpoint: `${o}/api/oauth/authorize`,
    token_endpoint: `${o}/api/oauth/token`,
    registration_endpoint: `${o}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['forum'],
  };
}

function okRedirect(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 2000) return false;
  try {
    const u = new URL(uri);
    if (['javascript:', 'data:', 'file:', 'vbscript:'].includes(u.protocol)) return false;
    if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return false;
    return !u.hash;
  } catch {
    return false;
  }
}

export const oauth = new Hono();

/** Динамическая регистрация клиента (RFC 7591). Клиенты публичные, секрета нет — защищает PKCE. */
oauth.post('/oauth/register', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { client_name?: string; redirect_uris?: unknown };
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  if (!uris.length || uris.length > 10 || !uris.every(okRedirect)) {
    return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris: https или http://localhost' }, 400);
  }
  const clientId = 'lfc_' + b64url(randomBytes(16));
  const name = String(b.client_name ?? 'MCP-клиент').slice(0, 100);
  await db()`insert into oauth_clients (client_id, client_name, redirect_uris) values (${clientId}, ${name}, ${uris as string[]})`;
  return c.json(
    { client_id: clientId, client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] },
    201,
  );
});

/** Начало авторизации: проверяем запрос, отправляем человека входить через GitHub, потом на страницу согласия. */
oauth.get('/oauth/authorize', async (c) => {
  const q = c.req.query();
  const [client] = await db()<{ client_id: string; client_name: string; redirect_uris: string[] }[]>`
    select client_id, client_name, redirect_uris from oauth_clients where client_id = ${q.client_id ?? ''}`;
  if (!client) return c.text('Неизвестный client_id — клиенту нужно заново зарегистрироваться', 400);
  if (!client.redirect_uris.includes(q.redirect_uri ?? '')) return c.text('redirect_uri не совпадает с зарегистрированным', 400);
  const back = (params: Record<string, string>) => {
    const u = new URL(q.redirect_uri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (q.state) u.searchParams.set('state', q.state);
    return c.redirect(u.toString());
  };
  if (q.response_type !== 'code') return back({ error: 'unsupported_response_type' });
  if (!q.code_challenge || q.code_challenge_method !== 'S256') return back({ error: 'invalid_request', error_description: 'Нужен PKCE S256' });

  const req = await new SignJWT({
    typ: 'oauth-req',
    cid: client.client_id,
    cn: client.client_name,
    ru: q.redirect_uri,
    cc: q.code_challenge,
    st: q.state ?? '',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('15m')
    .sign(key());
  const consent = `${origin(c)}/api/oauth/consent?req=${encodeURIComponent(req)}`;
  const loginPath = process.env.DEV_AUTH === '1' && !process.env.VERCEL && q.dev_login ? `/api/auth/dev?login=${encodeURIComponent(q.dev_login)}&` : '/api/auth/login?';
  return c.redirect(`${origin(c)}${loginPath}return=${encodeURIComponent(consent)}`);
});

async function readReq(req: string) {
  const { payload } = await jwtVerify(req, key());
  if (payload.typ !== 'oauth-req') throw new Error('bad request');
  return payload as unknown as { cid: string; cn: string; ru: string; cc: string; st: string };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Страница согласия. Токен сессии приходит во фрагменте URL (#token=…) после входа через GitHub. */
oauth.get('/oauth/consent', async (c) => {
  let r;
  try {
    r = await readReq(c.req.query('req') ?? '');
  } catch {
    return c.text('Ссылка устарела — начните подключение заново', 400);
  }
  const host = (() => {
    try {
      return new URL(r.ru).host || r.ru;
    } catch {
      return r.ru;
    }
  })();
  return c.html(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Доступ к LocalizationForum</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#1e2320;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
  @media (prefers-color-scheme:dark){body{background:#151816;color:#e6e9e6}.box{background:#1d2120!important;border-color:#2f3532!important}}
  .box{max-width:440px;background:#fff;border:1px solid #e2e0d8;border-radius:12px;padding:24px}
  h1{font-size:20px;margin:0 0 12px}.muted{color:#6b726d;font-size:14px}
  .row{display:flex;gap:8px;margin-top:20px}button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #2f6f4f;cursor:pointer}
  .ok{background:#2f6f4f;color:#fff}.no{background:transparent;color:inherit;border-color:#999}
</style></head><body><div class="box">
<h1>Подключить «${esc(r.cn)}» к LocalizationForum?</h1>
<p>Приложение получит доступ от вашего имени (<b id="who">…</b>): читать строки, предлагать варианты перевода, голосовать${''}, а если вы модератор — утверждать.</p>
<p class="muted">Варианты, предложенные через приложение, на сайте помечаются значком «ИИ». Отозвать доступ можно на странице «Токены» на сайте.</p>
<p class="muted">Возврат на: ${esc(host)}</p>
<div class="row"><button class="ok" id="ok">Разрешить</button><button class="no" id="no">Отмена</button></div>
<p class="muted" id="err"></p>
</div><script>
const m = location.hash.match(/token=([^&]+)/); const session = m ? decodeURIComponent(m[1]) : '';
history.replaceState(null, '', location.pathname + location.search);
const req = new URLSearchParams(location.search).get('req');
async function call(allow){
  const r = await fetch('/api/oauth/approve', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+session}, body: JSON.stringify({req, allow})});
  const d = await r.json().catch(()=>({})); if (d.redirect) location.href = d.redirect; else document.getElementById('err').textContent = d.error || 'Ошибка';
}
fetch('/api/me',{headers:{Authorization:'Bearer '+session}}).then(r=>r.json()).then(d=>{document.getElementById('who').textContent = d.user ? d.user.login : 'не выполнен вход';});
document.getElementById('ok').onclick=()=>call(true); document.getElementById('no').onclick=()=>call(false);
</script></body></html>`);
});

/** Решение пользователя: выдать одноразовый код (или отказ) и вернуть адрес для перехода в клиент. */
oauth.post('/oauth/approve', async (c) => {
  const user = await currentUser(c);
  if (!user) fail(401, 'Сначала войдите через GitHub');
  const b = (await c.req.json().catch(() => ({}))) as { req?: string; allow?: boolean };
  let r;
  try {
    r = await readReq(b.req ?? '');
  } catch {
    return fail(400, 'Ссылка устарела — начните подключение заново');
  }
  const u = new URL(r.ru);
  if (r.st) u.searchParams.set('state', r.st);
  if (!b.allow) {
    u.searchParams.set('error', 'access_denied');
    return c.json({ redirect: u.toString() });
  }
  const code = b64url(randomBytes(32));
  await db()`
    insert into oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
    values (${sha256(code)}, ${r.cid}, ${user!.id}, ${r.ru}, ${r.cc}, now() + interval '5 minutes')`;
  u.searchParams.set('code', code);
  return c.json({ redirect: u.toString() });
});

/** Обмен кода на токен (PKCE). */
oauth.post('/oauth/token', async (c) => {
  const ct = c.req.header('content-type') ?? '';
  const p: Record<string, string> = ct.includes('application/json')
    ? await c.req.json().catch(() => ({}))
    : Object.fromEntries(Object.entries(await c.req.parseBody().catch(() => ({}))).map(([k, v]) => [k, String(v)]));
  const err = (error: string, error_description: string) => c.json({ error, error_description }, 400);
  if (p.grant_type !== 'authorization_code') return err('unsupported_grant_type', 'Поддерживается только authorization_code');
  const [row] = await db()<{ client_id: string; user_id: number; redirect_uri: string; code_challenge: string; expired: boolean; client_name: string }[]>`
    delete from oauth_codes o using oauth_clients cl
    where o.code_hash = ${sha256(p.code ?? '')} and cl.client_id = o.client_id
    returning o.client_id, o.user_id, o.redirect_uri, o.code_challenge, o.expires_at < now() as expired, cl.client_name`;
  if (!row || row.expired) return err('invalid_grant', 'Код недействителен или устарел');
  if (p.client_id && p.client_id !== row.client_id) return err('invalid_grant', 'client_id не совпадает');
  if (p.redirect_uri && p.redirect_uri !== row.redirect_uri) return err('invalid_grant', 'redirect_uri не совпадает');
  const challenge = createHash('sha256').update(p.code_verifier ?? '').digest('base64url');
  if (challenge !== row.code_challenge) return err('invalid_grant', 'PKCE: code_verifier не подходит');
  const days = 180;
  const { token } = await createApiToken(row.user_id, row.client_name || 'MCP-клиент', 'oauth', row.client_id, days);
  return c.json({ access_token: token, token_type: 'Bearer', expires_in: days * 86400, scope: 'forum' });
});

// ---------- персональные токены (страница «Токены» на сайте) ----------

oauth.get('/tokens', async (c) => {
  const user = await currentUser(c);
  if (!user) fail(401, 'Нужно войти');
  const tokens = await db()`
    select id, name, kind, created_at, last_used_at, expires_at from api_tokens
    where user_id = ${user!.id} and (expires_at is null or expires_at > now()) order by created_at desc`;
  return c.json({ tokens });
});

oauth.post('/tokens', async (c) => {
  const user = await currentUser(c);
  if (!user) fail(401, 'Нужно войти');
  // Персональный токен можно создать только из сессии сайта, не другим токеном.
  if (c.req.header('authorization')?.slice(7).startsWith('lf_')) fail(403, 'Создавайте токены на сайте');
  const b = (await c.req.json().catch(() => ({}))) as { name?: string };
  const name = String(b.name ?? '').trim() || 'Персональный токен';
  const { id, token } = await createApiToken(user!.id, name, 'personal');
  return c.json({ id, token, name }, 201);
});

oauth.delete('/tokens/:id', async (c) => {
  const user = await currentUser(c);
  if (!user) fail(401, 'Нужно войти');
  await db()`delete from api_tokens where id = ${Number(c.req.param('id'))} and user_id = ${user!.id}`;
  return c.json({ ok: true });
});
