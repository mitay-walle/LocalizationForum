import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { allowedReturn, currentUser, isModerator, signSession, signState, upsertUser, verifyState, type User } from './auth.js';
import { db } from './db.js';
import { publishGame } from './publish.js';
import { SignJWT, jwtVerify } from 'jose';
import { env, list } from './env.js';
import { isBuiltin, listFormats, resolveFormat, validateLinesConfig, makeLinesFormat } from './formats/index.js';
import { exportLanguage, finalizeSource, importSource, importTranslation, type Game, type GameLink, type InFile } from './sync.js';
import { validateVariant, type Rule } from './validate.js';
import { variantLimits } from './limits.js';

const PAGE = 50;

export const app = new Hono().basePath('/api');

app.use(
  '*',
  cors({
    origin: (origin, c) => (list('SITE_ORIGINS').includes(origin) || origin === new URL(c.req.url).origin ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type', 'X-Sync-Token', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
    exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  }),
);

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
});

const fail = (status: 400 | 401 | 403 | 404 | 422 | 429, message: string): never => {
  throw new HTTPException(status, { message });
};

async function requireUser(c: Context): Promise<User> {
  const u = await currentUser(c);
  if (!u) fail(401, 'Нужно войти через GitHub');
  return u!;
}

async function gameBySlug(slug: string): Promise<Game> {
  const [g] = await db()<Game[]>`
    select id, slug, title, repo, format, source_lang, languages, rules, description, links, cover_url from games where slug = ${slug}`;
  if (!g) fail(404, 'Игра не найдена');
  return g!;
}

async function stringWithGame(id: number) {
  const [row] = await db()<(Game & { string_id: number; source: string; source_hash: string })[]>`
    select s.id as string_id, s.source, s.source_hash,
           g.id, g.slug, g.title, g.repo, g.format, g.source_lang, g.languages, g.rules
    from strings s join games g on g.id = s.game_id
    where s.id = ${id} and not s.removed`;
  if (!row) fail(404, 'Строка не найдена');
  return row!;
}

function checkLang(game: Game, lang: unknown): string {
  if (typeof lang !== 'string' || !game.languages.includes(lang)) fail(400, 'Язык не поддерживается этой игрой');
  return lang as string;
}

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return fail(400, 'Ожидался JSON');
  }
}

/** Проверки перевода: плейсхолдеры + правила языка игры + ограничения формата файла. */
async function checkText(g: Game & { source: string }, lang: string, text: string) {
  const issues = validateVariant(g.source, text, ((g.rules as Record<string, Rule[]>)[lang] ?? []) as Rule[]);
  const format = await resolveFormat(g.format);
  for (const m of format?.validate?.(text) ?? []) issues.unshift({ level: 'error', message: m });
  return issues;
}

// ---------- этапы перевода ----------

export const STATUSES = ['open', 'review', 'done'] as const;
type Status = (typeof STATUSES)[number];
const STATUS_TITLE: Record<Status, string> = { open: 'Групповой перевод', review: 'Апрув', done: 'Готово' };

async function langStatus(gameId: number, lang: string): Promise<Status> {
  const [r] = await db()<{ status: Status }[]>`select status from language_status where game_id = ${gameId} and lang = ${lang}`;
  return r?.status ?? 'open';
}

/**
 * Можно ли менять варианты/голоса/утверждения на этом этапе.
 * open — все; review — предлагать и голосовать только модераторам, утверждать можно; done — никому.
 */
async function requireStage(user: User, gameId: number, lang: string, action: 'propose' | 'vote' | 'approve') {
  await requireNotBanned(user, gameId);
  const st = await langStatus(gameId, lang);
  if (st === 'done') fail(403, 'Перевод на этапе «Готово» — он заморожен. Чтобы править, модератор должен вернуть этап «Апрув» или «Групповой перевод».');
  if (st === 'review' && action !== 'approve' && !(await isModerator(user, gameId, lang)))
    fail(403, 'Перевод на этапе «Апрув»: новые варианты и голоса закрыты, модераторы утверждают итог.');
}

// ---------- баны и лимиты (антиспам) ----------

export interface Ban {
  id: number;
  game: string | null;
  reason: string;
  until: Date | null;
}

/** Действующий бан: на всём форуме или (если задан gameId) в этой игре. Истёкшие не считаются. */
async function activeBan(userId: number, gameId: number | null): Promise<Ban | null> {
  const [b] = await db()<Ban[]>`
    select b.id, g.slug as game, b.reason, b.until from bans b left join games g on g.id = b.game_id
    where b.user_id = ${userId} and (b.game_id is null or b.game_id = ${gameId})
      and (b.until is null or b.until > now())
    order by b.game_id nulls first, b.until desc nulls first
    limit 1`;
  return b ?? null;
}

const fmtUntil = (d: Date | null) => (d ? `до ${new Date(d).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'бессрочно');

/** Забаненный может читать, но не менять ничего в игре (или нигде — при бане на весь форум). */
async function requireNotBanned(user: User, gameId: number | null) {
  const b = await activeBan(user.id, gameId);
  if (b) fail(403, `Вы заблокированы ${b.game ? 'в этой игре' : 'на форуме'} (${fmtUntil(b.until)})${b.reason ? `. Причина: ${b.reason}` : ''}. Читать можно, но предлагать, голосовать и загружать — нет.`);
}

// ---------- служебное ----------

app.get('/health', async (c) => {
  await db()`select 1`;
  return c.json({ ok: true });
});

// ---------- вход через GitHub ----------

app.get('/auth/login', async (c) => {
  const ret = c.req.query('return') ?? new URL(c.req.url).origin + '/';
  if (!allowedReturn(ret, c.req.url)) fail(400, 'Недопустимый адрес возврата');
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env('GITHUB_CLIENT_ID'));
  url.searchParams.set('redirect_uri', new URL('/api/auth/callback', c.req.url).toString());
  url.searchParams.set('state', await signState(ret));
  url.searchParams.set('allow_signup', 'true');
  return c.redirect(url.toString());
});

app.get('/auth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) fail(400, 'Нет code/state');
  // У GitHub-приложения один адрес возврата, поэтому публикация возвращается сюда же — различаем по state.
  const pub = await readPublishState(state!);
  if (pub) return handlePublishCallback(c, pub);
  let ret: string;
  try {
    ret = await verifyState(state!);
  } catch {
    return fail(400, 'Сессия входа устарела, попробуйте ещё раз');
  }
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env('GITHUB_CLIENT_ID'), client_secret: env('GITHUB_CLIENT_SECRET'), code }),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error_description?: string };
  if (!token.access_token) fail(400, `GitHub: ${token.error_description ?? 'не удалось войти'}`);
  const ghRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'loc-forum', Accept: 'application/vnd.github+json' },
  });
  if (!ghRes.ok) fail(400, 'GitHub не отдал профиль');
  const gh = (await ghRes.json()) as { id: number; login: string; avatar_url?: string };
  const user = await upsertUser(gh);
  // Токен GitHub не храним: он нужен был только чтобы узнать, кто вошёл.
  const session = await signSession(user.id);
  return c.redirect(`${ret}#token=${encodeURIComponent(session)}`);
});

/** Локальная разработка: вход без GitHub. Работает только при DEV_AUTH=1 и не на Vercel. */
app.get('/auth/dev', async (c) => {
  if (process.env.DEV_AUTH !== '1' || process.env.VERCEL) fail(404, 'Not found');
  const login = c.req.query('login') ?? 'dev';
  const id = 1_000_000_000 + [...login].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1_000_000, 7);
  const user = await upsertUser({ id, login });
  const ret = c.req.query('return') ?? new URL(c.req.url).origin + '/';
  return c.redirect(`${ret}#token=${encodeURIComponent(await signSession(user.id))}`);
});

app.get('/me', async (c) => {
  const u = await currentUser(c);
  if (!u) return c.json({ user: null });
  const mods = await db()<{ slug: string; lang: string }[]>`
    select g.slug, m.lang from moderators m join games g on g.id = m.game_id where m.user_id = ${u.id}`;
  // Действующие баны: game = null — на всём форуме
  const bans = await db()<Ban[]>`
    select b.id, g.slug as game, b.reason, b.until from bans b left join games g on g.id = b.game_id
    where b.user_id = ${u.id} and (b.until is null or b.until > now()) order by b.created_at`;
  return c.json({ user: u, moderates: mods, bans });
});

// ---------- чтение ----------

app.get('/games', async (c) => {
  const rows = await db()`
    select g.slug, g.title, g.repo, g.format, g.source_lang, g.languages, g.cover_url, g.links,
      left(g.description, 300) as description,
      (select count(*)::int from strings s where s.game_id = g.id and not s.removed) as total,
      coalesce((select jsonb_object_agg(lang, n) from (
        select a.lang, count(*)::int as n from approved a join strings s on s.id = a.string_id
        where s.game_id = g.id and not s.removed group by a.lang) t), '{}') as approved,
      coalesce((select jsonb_object_agg(ls.lang, ls.status) from language_status ls where ls.game_id = g.id), '{}') as status
    from games g order by g.title`;
  return c.json({ games: rows });
});

app.get('/games/:slug', async (c) => {
  const g = await gameBySlug(c.req.param('slug'));
  const stats = await db()`
    select l.lang,
      count(*) filter (where a.string_id is not null and a.source_hash = s.source_hash)::int as approved,
      count(*) filter (where a.string_id is not null and a.source_hash <> s.source_hash)::int as stale,
      count(*) filter (where a.string_id is null and exists (
        select 1 from variants v where v.string_id = s.id and v.lang = l.lang))::int as voting,
      count(*)::int as total
    from unnest(${g.languages}::text[]) as l(lang)
    cross join strings s
    left join approved a on a.string_id = s.id and a.lang = l.lang
    where s.game_id = ${g.id} and not s.removed
    group by l.lang`;
  const user = await currentUser(c);
  const st = await db()<{ lang: string; status: Status; updated_at: string; by: string | null }[]>`
    select ls.lang, ls.status, ls.updated_at, u.login as by from language_status ls left join users u on u.id = ls.updated_by
    where ls.game_id = ${g.id}`;
  const status = Object.fromEntries(g.languages.map((l) => [l, st.find((x) => x.lang === l) ?? { lang: l, status: 'open' }]));
  const moderates = Object.fromEntries(await Promise.all(g.languages.map(async (l) => [l, await isModerator(user, g.id, l)])));
  const ban = user ? await activeBan(user.id, g.id) : null;
  return c.json({ game: g, stats, status, moderates, canManage: await isModerator(user, g.id, '*'), ban, limits: variantLimits() });
});

app.get('/games/:slug/files', async (c) => {
  const g = await gameBySlug(c.req.param('slug'));
  const lang = checkLang(g, c.req.query('lang'));
  const files = await db()`
    select s.file, count(*)::int as total, count(a.string_id)::int as approved,
      count(*) filter (where a.string_id is null and exists (
        select 1 from variants v where v.string_id = s.id and v.lang = ${lang}))::int as voting
    from strings s left join approved a on a.string_id = s.id and a.lang = ${lang}
    where s.game_id = ${g.id} and not s.removed
    group by s.file order by s.file`;
  return c.json({ files });
});

app.get('/games/:slug/strings', async (c) => {
  const g = await gameBySlug(c.req.param('slug'));
  const lang = checkLang(g, c.req.query('lang'));
  const file = c.req.query('file') || null;
  const filter = c.req.query('filter') ?? 'all';
  const q = (c.req.query('q') ?? '').trim();
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const sql = db();
  const user = await currentUser(c);

  const cond = {
    all: sql`true`,
    untranslated: sql`a.string_id is null`,
    voting: sql`a.string_id is null and exists (select 1 from variants v where v.string_id = s.id and v.lang = ${lang})`,
    approved: sql`a.string_id is not null and a.source_hash = s.source_hash`,
    stale: sql`a.string_id is not null and a.source_hash <> s.source_hash`,
  }[filter];
  if (!cond) fail(400, 'Неизвестный фильтр');
  const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;

  const rows = await sql<{
    id: number; file: string; key: string; source: string; context: string | null;
    approved_text: string | null; approved_variant: number | null; stale: boolean | null; approved_by: string | null; total: number;
  }[]>`
    select s.id, s.file, s.key, s.source, s.context,
      a.text as approved_text, a.variant_id as approved_variant,
      (a.source_hash <> s.source_hash) as stale, m.login as approved_by,
      count(*) over ()::int as total
    from strings s
    left join approved a on a.string_id = s.id and a.lang = ${lang}
    left join users m on m.id = a.moderator_id
    where s.game_id = ${g.id} and not s.removed
      and (${file}::text is null or s.file = ${file})
      and ${cond!}
      and (${q} = '' or s.key ilike ${like} or s.source ilike ${like} or a.text ilike ${like})
    order by s.file, s.position
    limit ${PAGE} offset ${(page - 1) * PAGE}`;

  type Variant = { id: number; string_id: number; text: string; author: string | null; votes: number; mine: boolean; ai: boolean; created_at: string };
  const ids = rows.map((r) => r.id);
  const variants: Variant[] = ids.length
    ? await sql<Variant[]>`
        select v.id, v.string_id, v.text, u.login as author, v.created_at, v.ai,
          (select count(*)::int from votes x where x.variant_id = v.id) as votes,
          exists (select 1 from votes x where x.variant_id = v.id and x.user_id = ${user?.id ?? 0}) as mine
        from variants v left join users u on u.id = v.author_id
        where v.string_id = any(${ids}) and v.lang = ${lang}
        order by votes desc, v.created_at`
    : [];

  const byString = new Map<number, Variant[]>();
  for (const v of variants) {
    if (!byString.has(v.string_id)) byString.set(v.string_id, []);
    byString.get(v.string_id)!.push(v);
  }

  return c.json({
    page,
    pageSize: PAGE,
    total: rows[0]?.total ?? 0,
    canModerate: await isModerator(user, g.id, lang),
    status: await langStatus(g.id, lang),
    limits: variantLimits(),
    strings: rows.map(({ total: _t, ...r }) => ({ ...r, variants: byString.get(r.id) ?? [] })),
  });
});

/** Готовые файлы перевода в формате игры — их забирает Action в репо игры. */
app.get('/games/:slug/export', async (c) => {
  const g = await gameBySlug(c.req.param('slug'));
  const lang = checkLang(g, c.req.query('lang'));
  return c.json({ format: g.format, lang, ...(await exportLanguage(g, lang)) });
});

/** Титры: авторы утверждённых вариантов. */
app.get('/games/:slug/credits', async (c) => {
  const g = await gameBySlug(c.req.param('slug'));
  const lang = checkLang(g, c.req.query('lang'));
  const translators = await db()`
    select u.login, count(*)::int as strings
    from approved a join variants v on v.id = a.variant_id join users u on u.id = v.author_id
    join strings s on s.id = a.string_id
    where s.game_id = ${g.id} and a.lang = ${lang} and not s.removed
    group by u.login order by strings desc, u.login`;
  const moderators = await db()`
    select distinct u.login from moderators m join users u on u.id = m.user_id
    where m.game_id = ${g.id} and (m.lang = ${lang} or m.lang = '*') order by u.login`;
  return c.json({ translators, moderators });
});

// ---------- предложения и голоса ----------

app.post('/strings/:id/variants', async (c) => {
  const user = await requireUser(c);
  const s = await stringWithGame(Number(c.req.param('id')));
  const { lang, text, check } = await body<{ lang: string; text: string; check?: boolean }>(c);
  checkLang(s, lang);
  const value = String(text ?? '').replace(/\r\n/g, '\n');
  const issues = await checkText(s, lang, value);
  if (check) return c.json({ issues }); // только проверить, не сохранять
  await requireStage(user, s.id, lang, 'propose');
  if (issues.some((i) => i.level === 'error')) return c.json({ error: 'Вариант не прошёл проверку', issues }, 422);
  // Антиспам: лимиты проверяются под advisory-lock пользователя вместе со вставкой. Модераторы языка и админы — без лимитов.
  const exempt = await isModerator(user, s.id, lang);
  const L = variantLimits();
  const v = await db().begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(${user.id})`;
    if (!exempt) {
      const [n] = await sql<{ hour: number; mine: number; total: number }[]>`
        select
          (select count(*)::int from variants where author_id = ${user.id} and created_at > now() - interval '1 hour') as hour,
          (select count(*)::int from variants where string_id = ${s.string_id} and lang = ${lang} and author_id = ${user.id}) as mine,
          (select count(*)::int from variants where string_id = ${s.string_id} and lang = ${lang}) as total`;
      if (L.perHour && n.hour >= L.perHour) fail(429, `Слишком много вариантов за час: лимит ${L.perHour}. Попробуйте позже.`);
      if (L.perUserString && n.mine >= L.perUserString)
        fail(422, `Вы уже предложили максимум вариантов для этой строки (${L.perUserString}). Удалите свой вариант, чтобы предложить другой, или проголосуйте за лучший.`);
      if (L.perString && n.total >= L.perString) fail(422, `У этой строки уже максимум вариантов (${L.perString}). Проголосуйте за лучший из них.`);
    }
    const [row] = await sql<{ id: number }[]>`
      insert into variants (string_id, lang, text, author_id, ai)
      values (${s.string_id}, ${lang}, ${value}, ${user.id}, ${c.req.header('x-client') === 'mcp'})
      on conflict (string_id, lang, text) do nothing
      returning id`;
    return row;
  });
  if (!v) fail(422, 'Такой вариант уже предложен');
  return c.json({ id: v!.id, issues }, 201);
});

app.delete('/variants/:id', async (c) => {
  const user = await requireUser(c);
  const [v] = await db()<{ id: number; author_id: number | null; game_id: number; lang: string }[]>`
    select v.id, v.author_id, s.game_id, v.lang from variants v join strings s on s.id = v.string_id where v.id = ${Number(c.req.param('id'))}`;
  if (!v) fail(404, 'Вариант не найден');
  if (v!.author_id !== user.id && !(await isModerator(user, v!.game_id, v!.lang))) fail(403, 'Удалять можно только свои варианты');
  await requireStage(user, v!.game_id, v!.lang, 'propose');
  await db()`delete from variants where id = ${v!.id}`;
  return c.json({ ok: true });
});

async function variantScope(id: number) {
  const [v] = await db()<{ game_id: number; lang: string }[]>`
    select s.game_id, v.lang from variants v join strings s on s.id = v.string_id where v.id = ${id}`;
  if (!v) fail(404, 'Вариант не найден');
  return v!;
}

app.post('/variants/:id/vote', async (c) => {
  const user = await requireUser(c);
  const id = Number(c.req.param('id'));
  const vs = await variantScope(id);
  await requireStage(user, vs.game_id, vs.lang, 'vote');
  // Один голос на строку+язык: голос за этот вариант снимает голоса пользователя с остальных вариантов.
  // Всё в одной транзакции; advisory-lock на пользователя — чтобы два параллельных голоса не оставили оба.
  const { cleared, inserted } = await db().begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(${user.id})`;
    const gone = await sql<{ variant_id: number }[]>`
      delete from votes x using variants o, variants v
      where v.id = ${id} and o.string_id = v.string_id and o.lang = v.lang and o.id <> v.id
        and x.variant_id = o.id and x.user_id = ${user.id}
      returning x.variant_id`;
    const res = await sql`insert into votes (variant_id, user_id) select ${id}, ${user.id} where exists (select 1 from variants where id = ${id}) on conflict do nothing`;
    return { cleared: gone.map((r) => r.variant_id).sort((a, b) => a - b), inserted: res.count };
  });
  if (!inserted) {
    const [exists] = await db()`select 1 from variants where id = ${id}`;
    if (!exists) fail(404, 'Вариант не найден');
  }
  return c.json({ ...(await voteCount(id, user.id)), cleared });
});

app.delete('/variants/:id/vote', async (c) => {
  const user = await requireUser(c);
  const id = Number(c.req.param('id'));
  const vs = await variantScope(id);
  await requireStage(user, vs.game_id, vs.lang, 'vote');
  await db()`delete from votes where variant_id = ${id} and user_id = ${user.id}`;
  return c.json(await voteCount(id, user.id));
});

async function voteCount(variantId: number, userId: number) {
  const [r] = await db()<{ votes: number; mine: boolean }[]>`
    select count(*)::int as votes, bool_or(user_id = ${userId}) is true as mine from votes where variant_id = ${variantId}`;
  return r;
}

// ---------- модерация ----------

app.post('/strings/:id/approve', async (c) => {
  const user = await requireUser(c);
  const s = await stringWithGame(Number(c.req.param('id')));
  const { lang, variantId, text } = await body<{ lang: string; variantId?: number; text?: string }>(c);
  checkLang(s, lang);
  if (!(await isModerator(user, s.id, lang))) fail(403, 'Утверждать могут только модераторы');
  await requireStage(user, s.id, lang, 'approve');

  let value: string;
  let vid: number | null = null;
  if (variantId) {
    const [v] = await db()<{ id: number; text: string }[]>`
      select id, text from variants where id = ${variantId} and string_id = ${s.string_id} and lang = ${lang}`;
    if (!v) fail(404, 'Вариант не найден');
    value = v!.text;
    vid = v!.id;
  } else {
    // Модератор может поправить текст сам — проверки те же, что и для вариантов.
    value = String(text ?? '').replace(/\r\n/g, '\n');
    const issues = await checkText(s, lang, value);
    if (issues.some((i) => i.level === 'error')) return c.json({ error: 'Текст не прошёл проверку', issues }, 422);
  }
  await db()`
    insert into approved (string_id, lang, text, variant_id, source_hash, moderator_id)
    values (${s.string_id}, ${lang}, ${value!}, ${vid}, ${s.source_hash}, ${user.id})
    on conflict (string_id, lang) do update set
      text = excluded.text, variant_id = excluded.variant_id, source_hash = excluded.source_hash,
      moderator_id = excluded.moderator_id, approved_at = now()`;
  await notifyRepo(s);
  return c.json({ ok: true });
});

app.delete('/strings/:id/approve', async (c) => {
  const user = await requireUser(c);
  const s = await stringWithGame(Number(c.req.param('id')));
  const lang = checkLang(s, c.req.query('lang'));
  if (!(await isModerator(user, s.id, lang))) fail(403, 'Снимать утверждение могут только модераторы');
  await requireStage(user, s.id, lang, 'approve');
  await db()`delete from approved where string_id = ${s.string_id} and lang = ${lang}`;
  await notifyRepo(s);
  return c.json({ ok: true });
});

/** Дёрнуть Action в репо игры, чтобы он забрал свежий перевод. Не чаще раза в 2 минуты; остальное подберёт расписание. */
async function notifyRepo(g: Game) {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token || !g.repo) return;
  const due = await db()`
    update games set dispatched_at = now()
    where id = ${g.id} and (dispatched_at is null or dispatched_at < now() - interval '2 minutes') returning id`;
  if (!due.length) return;
  try {
    await fetch(`https://api.github.com/repos/${g.repo}/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'loc-forum' },
      body: JSON.stringify({ event_type: 'translations-updated' }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    console.warn('dispatch failed', e);
  }
}

// ---------- администрирование ----------

app.post('/admin/moderators', async (c) => {
  const user = await requireUser(c);
  if (!user.is_admin) fail(403, 'Только для администраторов');
  const { game, lang, login, remove } = await body<{ game: string; lang: string; login: string; remove?: boolean }>(c);
  const g = await gameBySlug(game);
  if (lang !== '*') checkLang(g, lang);
  const [u] = await db()<{ id: number }[]>`select id from users where lower(login) = lower(${login})`;
  if (!u) fail(404, 'Пользователь ещё ни разу не входил на сайт');
  if (remove) await db()`delete from moderators where game_id = ${g.id} and lang = ${lang} and user_id = ${u!.id}`;
  else await db()`insert into moderators (game_id, lang, user_id) values (${g.id}, ${lang}, ${u!.id}) on conflict do nothing`;
  return c.json({ ok: true });
});

// ---------- синхронизация с репо игры (GitHub Actions, заголовок X-Sync-Token) ----------

function requireSync(c: Context) {
  const t = c.req.header('x-sync-token');
  if (!t || t !== env('SYNC_TOKEN')) fail(401, 'Bad sync token');
}

interface GameMeta {
  slug: string;
  title: string;
  format: string;
  sourceLang?: string;
  languages: string[];
  repo?: string;
}

async function upsertGame(meta: GameMeta, rules: Record<string, Rule[]> = {}): Promise<Game> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(meta.slug ?? '')) fail(400, 'slug: латиница в нижнем регистре, цифры и дефис');
  if (!(await resolveFormat(meta.format))) fail(400, `Неизвестный формат ${meta.format}`);
  if (!Array.isArray(meta.languages) || !meta.languages.length) fail(400, 'languages: непустой список');
  const [g] = await db()<Game[]>`
    insert into games (slug, title, format, source_lang, languages, repo, rules)
    values (${meta.slug}, ${meta.title ?? meta.slug}, ${meta.format}, ${meta.sourceLang ?? 'en'},
            ${meta.languages}, ${meta.repo ?? null}, ${db().json(rules as never)})
    on conflict (slug) do update set
      title = excluded.title, format = excluded.format, source_lang = excluded.source_lang,
      languages = excluded.languages, repo = coalesce(excluded.repo, games.repo), rules = excluded.rules,
      updated_at = now()
    returning id, slug, title, repo, format, source_lang, languages, rules`;
  return g;
}

/**
 * Пачка исходников (или готового перевода, если указан lang).
 * Тело ограничено ~4 МБ, поэтому большие игры шлются несколькими пачками, а в конце — /admin/import/finish.
 */
app.post('/admin/import', async (c) => {
  requireSync(c);
  const b = await body<{ game: GameMeta; rules?: Record<string, Rule[]>; files: InFile[]; lang?: string; overwrite?: boolean }>(c);
  if (!Array.isArray(b.files)) fail(400, 'files: массив {path, content}');
  const g = await upsertGame(b.game, b.rules);
  if (b.lang) {
    checkLang(g, b.lang);
    return c.json(await importTranslation(g, b.lang, b.files, !!b.overwrite));
  }
  return c.json(await importSource(g, b.files));
});

app.post('/admin/import/finish', async (c) => {
  requireSync(c);
  const b = await body<{ slug: string; paths: string[] }>(c);
  const g = await gameBySlug(b.slug);
  if (!Array.isArray(b.paths) || !b.paths.length) fail(400, 'paths: список всех файлов source/');
  return c.json(await finalizeSource(g, b.paths));
});

// ---------- управление играми с сайта (вошедшие пользователи) ----------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

/** Управлять игрой (настройки, исходники, модераторы) может админ или модератор игры на все языки ('*'). */
async function canManage(user: User | null, gameId: number) {
  return isModerator(user, gameId, '*');
}

async function requireManager(c: Context): Promise<{ user: User; game: Game }> {
  const user = await requireUser(c);
  const game = await gameBySlug(c.req.param('slug')!);
  if (!(await canManage(user, game.id))) fail(403, 'Управлять игрой могут её владелец, модераторы всех языков и администраторы');
  if (c.req.method !== 'GET') await requireNotBanned(user, game.id); // забаненный управляющий может только смотреть
  return { user, game };
}

function cleanLanguages(list: unknown, sourceLang: string): string[] {
  if (!Array.isArray(list)) fail(400, 'Укажите хотя бы один язык перевода');
  const langs = [...new Set((list as unknown[]).map((l) => String(l).trim()).filter(Boolean))];
  const bad = langs.filter((l) => !LANG_RE.test(l));
  if (bad.length) fail(400, `Неверный код языка: ${bad.join(', ')} (нужен вид ru, uk, pt-BR)`);
  if (langs.includes(sourceLang)) fail(400, 'Язык оригинала не может быть языком перевода');
  if (!langs.length) fail(400, 'Укажите хотя бы один язык перевода');
  return langs;
}



const LINK_KINDS = ['steam', 'site', 'gog', 'itch', 'other'] as const;

/** Только http(s), без пробелов, не длиннее max. */
function cleanUrl(v: unknown, what: string, max = 500): string {
  const s = String(v ?? '').trim();
  let u: URL | null = null;
  try {
    u = new URL(s);
  } catch {
    /* ниже */
  }
  if (!u || !['http:', 'https:'].includes(u.protocol) || s.length > max || /\s/.test(s)) fail(400, `${what}: нужна ссылка http(s):// не длиннее ${max} символов`);
  return s;
}

/** Описание, ссылки и обложка игры. Поле не передано — undefined (не менять); пустое — null / []. */
function cleanInfo(b: { description?: unknown; links?: unknown; cover_url?: unknown }) {
  const out: { description?: string | null; links?: GameLink[]; cover_url?: string | null } = {};
  if (b.description !== undefined) {
    const d = String(b.description ?? '').replace(/\r\n/g, '\n').trim();
    if (d.length > 5000) fail(400, 'Описание игры — не длиннее 5000 символов');
    out.description = d || null;
  }
  if (b.cover_url !== undefined) out.cover_url = String(b.cover_url ?? '').trim() ? cleanUrl(b.cover_url, 'Обложка') : null;
  if (b.links !== undefined) {
    if (!Array.isArray(b.links)) fail(400, 'links: массив {kind, url, title?}');
    const list = b.links as { kind?: unknown; url?: unknown; title?: unknown }[];
    if (list.length > 10) fail(400, 'Не больше 10 ссылок');
    out.links = list.map((l) => {
      const kind = String(l?.kind ?? '') as GameLink['kind'];
      if (!LINK_KINDS.includes(kind)) fail(400, `Тип ссылки: ${LINK_KINDS.join(', ')}`);
      const title = String(l?.title ?? '').trim();
      if (title.length > 100) fail(400, 'Подпись ссылки — не длиннее 100 символов');
      return { kind, url: cleanUrl(l?.url, 'Ссылка'), ...(title ? { title } : {}) };
    });
  }
  return out;
}

/** Создать игру. Создатель становится её владельцем (модератор '*'). */
app.post('/games', async (c) => {
  const user = await requireUser(c);
  await requireNotBanned(user, null);
  const b = await body<{ slug: string; title: string; format: string; sourceLang?: string; languages: string[]; repo?: string; description?: string; links?: unknown; cover_url?: string }>(c);
  const slug = String(b.slug ?? '').trim();
  const title = String(b.title ?? '').trim();
  const sourceLang = String(b.sourceLang ?? 'en').trim() || 'en';
  if (!SLUG_RE.test(slug)) fail(400, 'Адрес: латиница в нижнем регистре, цифры и дефис');
  if (!title || title.length > 200) fail(400, 'Укажите название игры');
  if (!(await resolveFormat(String(b.format ?? '')))) fail(400, 'Выберите формат файлов');
  if (!LANG_RE.test(sourceLang)) fail(400, 'Неверный код языка оригинала');
  const languages = cleanLanguages(b.languages, sourceLang);
  const repo = b.repo?.trim() || null;
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(400, 'Репозиторий: owner/name');
  const info = cleanInfo(b);
  const sql = db();
  const created = await sql.begin(async (tx) => {
    const [g] = await tx<{ id: number }[]>`
      insert into games (slug, title, format, source_lang, languages, repo, created_by, description, links, cover_url)
      values (${slug}, ${title}, ${b.format}, ${sourceLang}, ${languages}, ${repo}, ${user.id},
              ${info.description ?? null}, ${sql.json((info.links ?? []) as never)}, ${info.cover_url ?? null})
      on conflict (slug) do nothing returning id`;
    if (!g) return null;
    await tx`insert into moderators (game_id, lang, user_id) values (${g.id}, '*', ${user.id})`;
    return g;
  });
  if (!created) fail(422, 'Игра с таким адресом уже есть');
  return c.json({ slug }, 201);
});

/** Настройки игры для страницы управления. */
app.get('/games/:slug/manage', async (c) => {
  const { game } = await requireManager(c);
  const moderators = await db()`
    select u.login, u.avatar_url, m.lang from moderators m join users u on u.id = m.user_id
    where m.game_id = ${game.id} order by m.lang, u.login`;
  const [files] = await db()<{ files: number; strings: number }[]>`
    select count(distinct file)::int as files, count(*)::int as strings from strings where game_id = ${game.id} and not removed`;
  return c.json({ game, moderators, ...files });
});

/** Изменить название, языки, репозиторий, правила проверок. */
app.post('/games/:slug/settings', async (c) => {
  const { game } = await requireManager(c);
  const b = await body<{
    title?: string; languages?: string[]; repo?: string | null; rules?: Record<string, Rule[]>; format?: string;
    description?: string | null; links?: unknown; cover_url?: string | null; force?: boolean;
  }>(c);
  let format = game.format;
  if (b.format !== undefined && b.format !== game.format) {
    if (!(await resolveFormat(String(b.format)))) fail(400, 'Неизвестный формат');
    const [{ n }] = await db()<{ n: number }[]>`select count(*)::int as n from strings where game_id = ${game.id}`;
    if (n) fail(422, 'Формат можно сменить, только пока в игре нет строк');
    format = String(b.format);
  }
  const title = b.title !== undefined ? String(b.title).trim() : game.title;
  if (!title || title.length > 200) fail(400, 'Укажите название игры');
  const languages = b.languages !== undefined ? cleanLanguages(b.languages, game.source_lang) : game.languages;
  // Убрать язык, у которого есть утверждённые переводы, можно только явно (force) — переводы сохранятся, но будут скрыты
  const dropped = game.languages.filter((l) => !languages.includes(l));
  if (dropped.length && !b.force) {
    const busy = await db()<{ lang: string; n: number }[]>`
      select a.lang, count(*)::int as n from approved a join strings s on s.id = a.string_id
      where s.game_id = ${game.id} and a.lang = any(${dropped}) group by a.lang`;
    if (busy.length)
      fail(422, `У языка ${busy.map((x) => `${x.lang} (${x.n})`).join(', ')} есть утверждённые переводы. Чтобы всё равно убрать язык, подтвердите (force) — переводы сохранятся, но будут скрыты.`);
  }
  const info = cleanInfo(b);
  const repo = b.repo === undefined ? game.repo : b.repo?.trim() || null;
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(400, 'Репозиторий: owner/name');
  let rules = game.rules;
  if (b.rules !== undefined) {
    if (typeof b.rules !== 'object' || Array.isArray(b.rules)) fail(400, 'rules: объект { "ru": [ … ] }');
    for (const [lang, list] of Object.entries(b.rules)) {
      if (!Array.isArray(list)) fail(400, `rules.${lang}: массив правил`);
      for (const r of list) {
        if (typeof r?.pattern !== 'string' || typeof r?.message !== 'string') fail(400, `rules.${lang}: у правила нужны pattern и message`);
        try {
          new RegExp(r.pattern, r.flags ?? 'u');
        } catch {
          fail(400, `rules.${lang}: неверное регулярное выражение ${r.pattern}`);
        }
      }
    }
    rules = b.rules;
  }
  await db()`
    update games set title = ${title}, languages = ${languages}, repo = ${repo}, format = ${format},
      rules = ${db().json(rules as never)},
      description = ${info.description !== undefined ? info.description : game.description ?? null},
      links = ${db().json((info.links ?? game.links ?? []) as never)},
      cover_url = ${info.cover_url !== undefined ? info.cover_url : game.cover_url ?? null},
      updated_at = now()
    where id = ${game.id}`;
  return c.json({ ok: true });
});

/**
 * Загрузка исходников с сайта, пачками (тело ≤ ~4 МБ).
 * replace=true в последней пачке вместе с paths — строки из файлов, которых нет в paths, скрываются.
 */
app.post('/games/:slug/source', async (c) => {
  const { game } = await requireManager(c);
  const b = await body<{ files: InFile[]; paths?: string[] }>(c);
  if (!Array.isArray(b.files)) fail(400, 'files: массив {path, content}');
  const res = await importSource(game, b.files);
  const removed = Array.isArray(b.paths) && b.paths.length ? (await finalizeSource(game, b.paths)).removed : 0;
  return c.json({ ...res, removed: res.removed + removed });
});

/** Пересобрать строки из сохранённых оригиналов по текущему описанию формата (после правки формата). */
app.post('/games/:slug/reparse', async (c) => {
  const { game } = await requireManager(c);
  const files = await db()<InFile[]>`select path, content from source_files where game_id = ${game.id}`;
  if (!files.length) fail(422, 'Оригиналы не сохранены — загрузите исходные файлы заново');
  const res = await importSource(game, files);
  const removed = (await finalizeSource(game, files.map((f) => f.path))).removed;
  return c.json({ ...res, removed: res.removed + removed });
});

/** Загрузка готового перевода с сайта: заполняет утверждённые строки. */
app.post('/games/:slug/translation', async (c) => {
  const { game } = await requireManager(c);
  const b = await body<{ lang: string; files: InFile[]; overwrite?: boolean }>(c);
  checkLang(game, b.lang);
  if (!Array.isArray(b.files)) fail(400, 'files: массив {path, content}');
  return c.json(await importTranslation(game, b.lang, b.files, !!b.overwrite));
});

/** Назначить или снять модератора. lang = '*' — все языки (может управлять игрой). */
app.post('/games/:slug/moderators', async (c) => {
  const { user, game } = await requireManager(c);
  const { lang, login, remove } = await body<{ lang: string; login: string; remove?: boolean }>(c);
  if (lang !== '*') checkLang(game, lang);
  const [u] = await db()<{ id: number }[]>`select id from users where lower(login) = lower(${String(login ?? '').trim()})`;
  if (!u) fail(404, 'Этот пользователь ещё ни разу не входил на сайт');
  if (remove) {
    if (u!.id === user.id && lang === '*' && !user.is_admin) fail(422, 'Нельзя снять права управления с самого себя');
    await db()`delete from moderators where game_id = ${game.id} and lang = ${lang} and user_id = ${u!.id}`;
  } else {
    await db()`insert into moderators (game_id, lang, user_id) values (${game.id}, ${lang}, ${u!.id}) on conflict do nothing`;
  }
  return c.json({ ok: true });
});

// ---------- баны: в игре (управляющий игрой или админ) и на всём форуме (только админ) ----------

async function listBans(gameId: number | null) {
  const sql = db();
  return sql`
    select b.id, u.login, b.reason, b.until, b.created_at, c.login as by, g.slug as game
    from bans b join users u on u.id = b.user_id left join users c on c.id = b.created_by left join games g on g.id = b.game_id
    where ${gameId === null ? sql`b.game_id is null` : sql`b.game_id = ${gameId}`} and (b.until is null or b.until > now())
    order by b.created_at desc`;
}

/**
 * Забанить. days не задан — бессрочно. purge — удалить варианты и голоса пользователя в игре (или везде при глобальном бане);
 * утверждённые переводы не трогаем: варианты, выбранные как утверждённые, остаются.
 */
async function createBan(by: User, gameId: number | null, b: { login?: string; reason?: string; days?: number | null; purge?: boolean }) {
  const sql = db();
  const [target] = await sql<{ id: number; login: string; is_admin: boolean }[]>`
    select id, login, is_admin from users where lower(login) = lower(${String(b.login ?? '').trim()})`;
  if (!target) fail(404, 'Этот пользователь ещё ни разу не входил на сайт');
  if (target!.id === by.id) fail(422, 'Нельзя забанить самого себя');
  if (target!.is_admin && !by.is_admin) fail(403, 'Администратора может забанить только администратор');
  const reason = String(b.reason ?? '').trim();
  if (!reason || reason.length > 500) fail(400, 'Укажите причину бана (до 500 символов)');
  let days: number | null = null;
  if (b.days !== undefined && b.days !== null) {
    days = Number(b.days);
    if (!Number.isFinite(days) || days <= 0 || days > 3650) fail(400, 'Срок бана — число дней от 1 до 3650 (или не указывать — навсегда)');
  }
  return sql.begin(async (tx) => {
    const [ban] = await tx<{ id: number; until: Date | null }[]>`
      insert into bans (user_id, game_id, reason, until, created_by)
      values (${target!.id}, ${gameId}, ${reason}, ${days === null ? null : tx`now() + ${days}::float8 * interval '1 day'`}, ${by.id})
      returning id, until`;
    const purged = { variants: 0, votes: 0 };
    if (b.purge) {
      const scope = gameId === null ? tx`true` : tx`s.game_id = ${gameId}`;
      const votes = await tx`
        delete from votes x using variants v, strings s
        where x.variant_id = v.id and v.string_id = s.id and x.user_id = ${target!.id} and ${scope}`;
      const vars = await tx`
        delete from variants v using strings s
        where v.string_id = s.id and v.author_id = ${target!.id} and ${scope}
          and not exists (select 1 from approved a where a.variant_id = v.id)`;
      purged.votes = votes.count;
      purged.variants = vars.count;
    }
    return { ok: true, id: ban.id, login: target!.login, until: ban.until, purged };
  });
}

/** Снять бан: ?id= или ?login= (все баны пользователя в этой области). */
async function removeBan(gameId: number | null, c: Context) {
  const sql = db();
  const id = Number(c.req.query('id') || 0);
  const login = c.req.query('login');
  if (!id && !login) fail(400, 'Укажите id или login');
  const scope = gameId === null ? sql`game_id is null` : sql`game_id = ${gameId}`;
  const res = id
    ? await sql`delete from bans where id = ${id} and ${scope}`
    : await sql`delete from bans where user_id in (select id from users where lower(login) = lower(${login!})) and ${scope}`;
  if (!res.count) fail(404, 'Бан не найден');
  return { ok: true, removed: res.count };
}

app.get('/games/:slug/bans', async (c) => {
  const { game } = await requireManager(c);
  return c.json({ bans: await listBans(game.id) });
});
app.post('/games/:slug/bans', async (c) => {
  const { user, game } = await requireManager(c);
  return c.json(await createBan(user, game.id, await body(c)), 201);
});
app.delete('/games/:slug/bans', async (c) => {
  const { game } = await requireManager(c);
  return c.json(await removeBan(game.id, c));
});

async function requireAdmin(c: Context) {
  const user = await requireUser(c);
  if (!user.is_admin) fail(403, 'Только для администраторов');
  return user;
}
app.get('/admin/bans', async (c) => {
  await requireAdmin(c);
  return c.json({ bans: await listBans(null) });
});
app.post('/admin/bans', async (c) => {
  const user = await requireAdmin(c);
  return c.json(await createBan(user, null, await body(c)), 201);
});
app.delete('/admin/bans', async (c) => {
  await requireAdmin(c);
  return c.json(await removeBan(null, c));
});

/** Удалить игру целиком (только администратор). */
app.delete('/games/:slug', async (c) => {
  const user = await requireUser(c);
  if (!user.is_admin) fail(403, 'Удалять игры может только администратор');
  const g = await gameBySlug(c.req.param('slug'));
  await db()`delete from games where id = ${g.id}`;
  return c.json({ ok: true });
});


// ---------- форматы файлов (data-driven) ----------

const FORMAT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

app.get('/formats', async (c) => c.json({ formats: await listFormats() }));

/** Проверить конфиг формата на примере файла: какие строки он найдёт и собирается ли файл обратно байт в байт. */
app.post('/formats/preview', async (c) => {
  await requireUser(c);
  const b = await body<{ config?: unknown; format?: string; path: string; content: string }>(c);
  let format;
  try {
    format = b.config !== undefined ? makeLinesFormat('preview', b.config) : await resolveFormat(String(b.format));
  } catch (e) {
    return fail(422, (e as Error).message);
  }
  if (!format) fail(404, 'Формат не найден');
  const path = String(b.path ?? 'file');
  const content = String(b.content ?? '');
  if (content.length > 2_000_000) fail(400, 'Файл слишком большой для предпросмотра');
  const matches = format!.matches(path);
  let strings: { key: string; source: string; context?: string }[] = [];
  let roundTrip: boolean | null = null;
  try {
    strings = format!.parse(path, content);
    if (format!.skeleton) {
      roundTrip = format!.serialize(path, strings.map((s) => ({ key: s.key, source: s.source, text: s.source })), content) === content;
    }
  } catch (e) {
    return fail(422, `Не удалось разобрать файл: ${(e as Error).message}`);
  }
  return c.json({ matches, count: strings.length, roundTrip, strings: strings.slice(0, 200) });
});

/** Создать пользовательский построчный формат. */
app.post('/formats', async (c) => {
  const user = await requireUser(c);
  await requireNotBanned(user, null);
  const b = await body<{ slug: string; title: string; config: unknown }>(c);
  const slug = String(b.slug ?? '').trim();
  const title = String(b.title ?? '').trim();
  if (!FORMAT_SLUG_RE.test(slug)) fail(400, 'Код формата: латиница в нижнем регистре, цифры и дефис, 2–41 символ');
  if (isBuiltin(slug)) fail(422, 'Такой код занят встроенным форматом');
  if (!title || title.length > 120) fail(400, 'Укажите название формата');
  let config;
  try {
    config = validateLinesConfig(b.config);
  } catch (e) {
    return fail(422, (e as Error).message);
  }
  const res = await db()`
    insert into custom_formats (slug, title, config, created_by) values (${slug}, ${title}, ${db().json(config as never)}, ${user.id})
    on conflict (slug) do nothing`;
  if (!res.count) fail(422, 'Формат с таким кодом уже есть');
  return c.json({ slug }, 201);
});

/** Изменить свой формат (или любой — администратору). Строки игр пересчитаются при следующей загрузке исходников. */
app.post('/formats/:slug', async (c) => {
  const user = await requireUser(c);
  await requireNotBanned(user, null);
  const slug = c.req.param('slug');
  const [f] = await db()<{ created_by: number | null }[]>`select created_by from custom_formats where slug = ${slug}`;
  if (!f) fail(404, 'Формат не найден (встроенные форматы и пресеты не редактируются — создайте свой на их основе)');
  if (f!.created_by !== user.id && !user.is_admin) fail(403, 'Менять формат может его автор или администратор');
  const b = await body<{ title?: string; config?: unknown }>(c);
  let config;
  try {
    config = b.config !== undefined ? validateLinesConfig(b.config) : undefined;
  } catch (e) {
    return fail(422, (e as Error).message);
  }
  await db()`
    update custom_formats set
      title = coalesce(${b.title?.trim() || null}, title),
      config = coalesce(${config ? db().json(config as never) : null}, config),
      updated_at = now()
    where slug = ${slug}`;
  const games = await db()<{ slug: string }[]>`select slug from games where format = ${slug}`;
  return c.json({ ok: true, games: games.map((g) => g.slug) });
});


// ---------- «Опубликовать в GitHub» ----------

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$/;
const jwtKey = () => new TextEncoder().encode(env('JWT_SECRET'));

/** Начать публикацию: вернуть ссылку на GitHub, где пользователь разрешит запись в публичные репо (один раз, токен не хранится). */
app.post('/games/:slug/publish/start', async (c) => {
  const { user, game } = await requireManager(c);
  const b = await body<{ version?: string; return?: string }>(c);
  const version = String(b.version ?? '').trim();
  if (version && !VERSION_RE.test(version)) fail(400, 'Версия: латиница, цифры, точки и дефисы, например 1.0 или 1.6.2');
  if (!game.repo) fail(400, 'Сначала укажите репозиторий (owner/name) и сохраните настройки');
  const ret = b.return ?? '';
  if (!allowedReturn(ret, c.req.url)) fail(400, 'Недопустимый адрес возврата');
  const state = await new SignJWT({ typ: 'publish', gid: game.id, uid: user.id, ver: version, ret })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('15m')
    .sign(jwtKey());
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env('GITHUB_CLIENT_ID'));
  url.searchParams.set('redirect_uri', new URL('/api/auth/callback', c.req.url).toString());
  url.searchParams.set('scope', 'public_repo');
  url.searchParams.set('state', state);
  return c.json({ url: url.toString() });
});

type PublishState = { gid: number; uid: number; ver: string; ret: string };

async function readPublishState(state: string): Promise<PublishState | null> {
  try {
    const { payload } = await jwtVerify(state, jwtKey());
    return payload.typ === 'publish' ? (payload as unknown as PublishState) : null;
  } catch {
    return null;
  }
}

/** GitHub вернул пользователя с кодом: получаем одноразовый токен, публикуем, возвращаем на сайт с итогом. */
async function handlePublishCallback(c: Context, st: PublishState) {
  const [g] = await db()<Game[]>`select id, slug, title, repo, format, source_lang, languages, rules from games where id = ${st.gid}`;
  const back = (result: unknown) => c.redirect(`${st.ret}#/g/${encodeURIComponent(g?.slug ?? '')}/settings?pub=${encodeURIComponent(JSON.stringify(result))}`);
  if (!g) return back({ error: 'Игра не найдена' });
  const [u] = await db()<User[]>`select id, login, avatar_url, is_admin from users where id = ${st.uid}`;
  if (!(await isModerator(u ?? null, g.id, '*'))) return back({ error: 'Нет прав на управление игрой' });
  if (c.req.query('error')) return back({ error: 'Доступ к GitHub не выдан' });

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env('GITHUB_CLIENT_ID'),
      client_secret: env('GITHUB_CLIENT_SECRET'),
      code: c.req.query('code'),
      redirect_uri: new URL('/api/auth/callback', c.req.url).toString(),
    }),
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!tok.access_token) return back({ error: `GitHub: ${tok.error_description ?? 'не удалось получить доступ'}` });
  try {
    const site = new URL(st.ret);
    const result = await publishGame(g, tok.access_token, { version: st.ver || undefined, site: site.origin + site.pathname });
    return back(result);
  } catch (e) {
    return back({ error: (e as Error).message });
  }
}


// ---------- смена этапа перевода ----------

/** Сменить этап для языка: модератор этого языка, управляющий игрой или администратор. */
app.post('/games/:slug/status', async (c) => {
  const user = await requireUser(c);
  const g = await gameBySlug(c.req.param('slug'));
  const { lang, status } = await body<{ lang: string; status: string }>(c);
  checkLang(g, lang);
  if (!STATUSES.includes(status as Status)) fail(400, 'Этап: open (групповой перевод), review (апрув) или done (готово)');
  if (!(await isModerator(user, g.id, lang))) fail(403, 'Менять этап могут модераторы этого языка');
  await requireNotBanned(user, g.id);
  await db()`
    insert into language_status (game_id, lang, status, updated_by) values (${g.id}, ${lang}, ${status}, ${user.id})
    on conflict (game_id, lang) do update set status = excluded.status, updated_by = excluded.updated_by, updated_at = now()`;
  return c.json({ ok: true, status, title: STATUS_TITLE[status as Status] });
});
