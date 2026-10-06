import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { allowedReturn, currentUser, isModerator, signSession, signState, upsertUser, verifyState, type User } from './auth.js';
import { db } from './db.js';
import { env, list } from './env.js';
import { formatIds } from './formats/index.js';
import { exportLanguage, finalizeSource, importSource, importTranslation, type Game, type InFile } from './sync.js';
import { validateVariant, type Rule } from './validate.js';

const PAGE = 50;

export const app = new Hono().basePath('/api');

app.use(
  '*',
  cors({
    origin: (origin, c) => (list('SITE_ORIGINS').includes(origin) || origin === new URL(c.req.url).origin ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type', 'X-Sync-Token'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  }),
);

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Внутренняя ошибка сервера' }, 500);
});

const fail = (status: 400 | 401 | 403 | 404 | 422, message: string): never => {
  throw new HTTPException(status, { message });
};

async function requireUser(c: Context): Promise<User> {
  const u = await currentUser(c);
  if (!u) fail(401, 'Нужно войти через GitHub');
  return u!;
}

async function gameBySlug(slug: string): Promise<Game> {
  const [g] = await db()<Game[]>`select id, slug, title, repo, format, source_lang, languages, rules from games where slug = ${slug}`;
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
  return c.json({ user: u, moderates: mods });
});

// ---------- чтение ----------

app.get('/games', async (c) => {
  const rows = await db()`
    select g.slug, g.title, g.repo, g.format, g.source_lang, g.languages,
      (select count(*)::int from strings s where s.game_id = g.id and not s.removed) as total,
      coalesce((select jsonb_object_agg(lang, n) from (
        select a.lang, count(*)::int as n from approved a join strings s on s.id = a.string_id
        where s.game_id = g.id and not s.removed group by a.lang) t), '{}') as approved
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
  return c.json({ game: g, stats });
});

app.get('/games/:slug/files', async (c) => {
  const g = await gameBySlug(c.req.param('slug'));
  const lang = checkLang(g, c.req.query('lang'));
  const files = await db()`
    select s.file, count(*)::int as total, count(a.string_id)::int as approved
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

  type Variant = { id: number; string_id: number; text: string; author: string | null; votes: number; mine: boolean; created_at: string };
  const ids = rows.map((r) => r.id);
  const variants: Variant[] = ids.length
    ? await sql<Variant[]>`
        select v.id, v.string_id, v.text, u.login as author, v.created_at,
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
  const issues = validateVariant(s.source, value, ((s.rules as Record<string, Rule[]>)[lang] ?? []) as Rule[]);
  if (check) return c.json({ issues }); // только проверить, не сохранять
  if (issues.some((i) => i.level === 'error')) return c.json({ error: 'Вариант не прошёл проверку', issues }, 422);
  const [v] = await db()`
    insert into variants (string_id, lang, text, author_id)
    values (${s.string_id}, ${lang}, ${value}, ${user.id})
    on conflict (string_id, lang, text) do nothing
    returning id`;
  if (!v) fail(422, 'Такой вариант уже предложен');
  return c.json({ id: v!.id, issues }, 201);
});

app.delete('/variants/:id', async (c) => {
  const user = await requireUser(c);
  const [v] = await db()<{ id: number; author_id: number | null; game_id: number; lang: string }[]>`
    select v.id, v.author_id, s.game_id, v.lang from variants v join strings s on s.id = v.string_id where v.id = ${Number(c.req.param('id'))}`;
  if (!v) fail(404, 'Вариант не найден');
  if (v!.author_id !== user.id && !(await isModerator(user, v!.game_id, v!.lang))) fail(403, 'Удалять можно только свои варианты');
  await db()`delete from variants where id = ${v!.id}`;
  return c.json({ ok: true });
});

app.post('/variants/:id/vote', async (c) => {
  const user = await requireUser(c);
  const id = Number(c.req.param('id'));
  const res = await db()`insert into votes (variant_id, user_id) select ${id}, ${user.id} where exists (select 1 from variants where id = ${id}) on conflict do nothing`;
  if (!res.count) {
    const [exists] = await db()`select 1 from variants where id = ${id}`;
    if (!exists) fail(404, 'Вариант не найден');
  }
  return c.json(await voteCount(id, user.id));
});

app.delete('/variants/:id/vote', async (c) => {
  const user = await requireUser(c);
  const id = Number(c.req.param('id'));
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
    const issues = validateVariant(s.source, value, ((s.rules as Record<string, Rule[]>)[lang] ?? []) as Rule[]);
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
  if (!formatIds.includes(meta.format)) fail(400, `format: одно из ${formatIds.join(', ')}`);
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
