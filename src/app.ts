import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { allowedReturn, currentUser, isModerator, signSession, signState, upsertUser, verifyState, type User } from './auth.js';
import { db } from './db.js';
import { SignJWT, jwtVerify } from 'jose';
import { env, list } from './env.js';
import { PASSTHROUGH, fileFormat, isBuiltin, isMapKey, listFormats, resolveFormat, validateLinesConfig, makeLinesFormat } from './formats/index.js';
import { TRASH_DAYS, deleteSource, exportLanguage, finalizeSource, importSource, importTranslation, outBytes, restoreSource, targetEncoding, type Game, type GameLink, type InFile } from './sync.js';
import { ENCODINGS, encodeText, encodingSupport, isEncoding, unrepresentable } from './encoding.js';
import { validateVariant, type Rule } from './validate.js';
import { variantLimits } from './limits.js';

const PAGE = 50;

export const app = new Hono().basePath('/api');

// ---------- кэш CDN Vercel для анонимного чтения ----------
// CDN Vercel не кэширует запросы с Authorization и ответы с Vary: Cookie, а s-maxage/stale-while-revalidate
// срезает перед отправкой в браузер — то есть кэширует только CDN. Публичный кэш ставим лишь анонимным
// запросам (без Authorization и без cookie): у вошедших в ответе свои поля (mine, canModerate, ban…) — им private.
// Vary: Origin — чтобы закэшированный ответ не отдал другому сайту чужой Access-Control-Allow-Origin.
// Подключается раньше CORS, чтобы видеть его заголовки (и не дублировать Vary).
const PUBLIC_READS: [RegExp, string][] = [
  [/^\/api\/games\/[^/]+\/export$/, 'public, s-maxage=300, stale-while-revalidate=3600'],
  [/^\/api\/(games(\/[^/]+(\/(files|strings|credits))?)?|formats(\/[^/]+)?)$/, 'public, s-maxage=60, stale-while-revalidate=600'],
];
app.use('*', async (c, next) => {
  await next();
  if (c.req.method !== 'GET') return;
  const rule = PUBLIC_READS.find(([re]) => re.test(c.req.path));
  if (!rule) return;
  if (!c.req.header('authorization') && !c.req.header('cookie') && c.res.status === 200) {
    c.header('Cache-Control', rule[1]);
    const vary = c.res.headers.get('Vary');
    if (!vary?.split(',').some((v) => v.trim().toLowerCase() === 'origin')) c.header('Vary', vary ? `${vary}, Origin` : 'Origin');
  } else {
    c.header('Cache-Control', 'private, no-store');
  }
});

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

const fail = (status: 400 | 401 | 403 | 404 | 409 | 422 | 429, message: string): never => {
  throw new HTTPException(status, { message });
};

async function requireUser(c: Context): Promise<User> {
  const u = await currentUser(c);
  if (!u) fail(401, 'Нужно войти через GitHub');
  return u!;
}

async function gameBySlug(slug: string): Promise<Game> {
  const [g] = await db()<Game[]>`
    select id, slug, title, repo, format, format_map, source_lang, languages, rules, description, links, cover_url, encodings, source_encoding from games where slug = ${slug}`;
  if (!g) fail(404, 'Игра не найдена');
  return g!;
}

async function stringWithGame(id: number) {
  const [row] = await db()<(Game & { string_id: number; source: string; source_hash: string; file: string })[]>`
    select s.id as string_id, s.source, s.source_hash, s.file,
           g.id, g.slug, g.title, g.repo, g.format, g.format_map, g.source_lang, g.languages, g.rules, g.encodings
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
async function checkText(g: Game & { source: string; file?: string }, lang: string, text: string) {
  const issues = validateVariant(g.source, text, ((g.rules as Record<string, Rule[]>)[lang] ?? []) as Rule[]);
  // Формат — у каждого файла свой: каким файл разобран при загрузке, иначе по карте форматов игры
  const [src] = g.file ? await db()<{ encoding: string; format: string | null }[]>`select encoding, format from source_files where game_id = ${g.id} and path = ${g.file}` : [];
  const slug = src?.format ?? (g.file ? fileFormat(g, g.file) : g.format);
  const format = slug && slug !== PASSTHROUGH ? await resolveFormat(slug) : null;
  for (const m of format?.validate?.(text) ?? []) issues.unshift({ level: 'error', message: m });
  // Символы, которых нет в кодировке выгрузки этого файла для языка (только для однобайтовых и прочих неюникодных)
  const enc = targetEncoding(g, lang, src?.encoding);
  const bad = unrepresentable(text, enc);
  if (bad.length)
    issues.unshift({
      level: 'error',
      message: `${bad.length === 1 ? 'Символ' : 'Символы'} ${bad.slice(0, 5).map((c) => `«${c}»`).join(', ')} нельзя записать в кодировке ${enc} — выберите другую кодировку в настройках игры`,
    });
  return issues;
}

// ---------- этапы перевода ----------

export const STATUSES = ['open', 'review', 'done'] as const;
type Status = (typeof STATUSES)[number];
const STATUS_TITLE: Record<Status, string> = { open: 'Групповой перевод', review: 'Апрув', done: 'Готово' };

async function langRevision(gameId: number, lang: string): Promise<number> {
  const [r] = await db()<{ revision: number }[]>`select revision from language_status where game_id = ${gameId} and lang = ${lang}`;
  return r?.revision ?? 1;
}

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
    select g.slug, g.title, g.repo, g.format, g.format_map, g.source_lang, g.languages, g.cover_url, g.links,
      left(g.description, 300) as description,
      (select count(*)::int from strings s where s.game_id = g.id and not s.removed) as total,
      coalesce((select jsonb_object_agg(lang, n) from (
        select a.lang, count(*)::int as n from approved a join strings s on s.id = a.string_id
        where s.game_id = g.id and not s.removed group by a.lang) t), '{}') as approved,
      coalesce((select jsonb_object_agg(ls.lang, ls.status) from language_status ls where ls.game_id = g.id), '{}') as status
    from games g order by g.title`;
  return c.json({ games: rows });
});

/**
 * Расширения файлов игры: сколько файлов и строк, какой формат назначен в карте (format) и какими
 * форматами файлы разобраны сейчас (parsed — если отличается от format, нужен «Пересчитать строки»).
 */
async function extensionStats(g: Game) {
  const rows = await db()<{ ext: string; files: number; strings: number; parsed: string[] }[]>`
    with f as (
      select path, format from source_files where game_id = ${g.id}
      union all
      select distinct s.file, null from strings s where s.game_id = ${g.id} and not s.removed
        and not exists (select 1 from source_files sf where sf.game_id = s.game_id and sf.path = s.file)
    )
    select coalesce(lower(substring(f.path from '[^/.][^/]*([.][^./]+)$')), '') as ext,
      count(*)::int as files,
      coalesce(sum((select count(*) from strings s where s.game_id = ${g.id} and s.file = f.path and not s.removed)), 0)::int as strings,
      coalesce(array_agg(distinct f.format) filter (where f.format is not null), '{}') as parsed
    from f group by 1 order by 1`;
  const map = g.format_map ?? {};
  return rows.map((r) => ({ ...r, format: (r.ext ? map[r.ext] : undefined) ?? map['*'] ?? (g.format || null) }));
}

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
  const st = await db()<{ lang: string; status: Status; revision: number; updated_at: string; by: string | null }[]>`
    select ls.lang, ls.status, ls.revision, ls.updated_at, u.login as by from language_status ls left join users u on u.id = ls.updated_by
    where ls.game_id = ${g.id}`;
  const status = Object.fromEntries(g.languages.map((l) => [l, st.find((x) => x.lang === l) ?? { lang: l, status: 'open', revision: 1 }]));
  const moderates = Object.fromEntries(await Promise.all(g.languages.map(async (l) => [l, await isModerator(user, g.id, l)])));
  const ban = user ? await activeBan(user.id, g.id) : null;
  const formats = await extensionStats(g);
  return c.json({ game: g, stats, formats, status, moderates, canManage: await isModerator(user, g.id, '*'), ban, limits: variantLimits() });
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
          exists (select 1 from votes x where x.variant_id = v.id and x.user_id = ${user?.id ?? 0}) as mine,
          (select max(h.revision) from approved_history h where h.string_id = v.string_id and h.lang = v.lang and h.text = v.text) as was_approved_rev
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
    revision: await langRevision(g.id, lang),
    limits: variantLimits(),
    strings: rows.map(({ total: _t, ...r }) => ({ ...r, variants: byString.get(r.id) ?? [] })),
  });
});

/** Готовые файлы перевода в формате игры — их забирает Action в репо игры. */
app.get('/games/:slug/export', async (c) => {
  const g = await gameBySlug(c.req.param('slug'));
  const lang = checkLang(g, c.req.query('lang'));
  const ex = await exportLanguage(g, lang);
  // ?binary=1 — готовые байты файлов (base64) в нужной кодировке, с BOM: для zip и выгрузки в репо игры
  if (c.req.query('binary') === '1')
    return c.json({ ...ex, format: g.format, format_map: g.format_map, lang, files: ex.files.map((f) => ({ path: f.path, encoding: f.encoding, data: Buffer.from(outBytes(f, encodeText)).toString('base64') })) });
  // без binary: текст файлов; файлы «как есть» (картинки и т. п.) — байтами в data (base64)
  return c.json({
    format: g.format, format_map: g.format_map, lang, ...ex,
    files: ex.files.map((f) => (f.data ? { path: f.path, content: '', encoding: f.encoding, data: Buffer.from(f.data).toString('base64') } : f)),
  });
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

/**
 * Дёрнуть Action в репо игры, чтобы он забрал свежий перевод. Не чаще раза в 10 минут на игру.
 * Склейка: workflow, запущенный по repository_dispatch, сначала ждёт 10 минут и только потом выгружает —
 * поэтому утверждения, пропущенные троттлингом (они в пределах 10 минут после отправленного dispatch), попадут в тот же запуск.
 */
export const DISPATCH_INTERVAL_MIN = 10;
async function notifyRepo(g: Game) {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token || !g.repo) return;
  const due = await db()`
    update games set dispatched_at = now()
    where id = ${g.id} and (dispatched_at is null or dispatched_at < now() - ${DISPATCH_INTERVAL_MIN} * interval '1 minute') returning id`;
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
  /** формат по умолчанию (старые game.json); формат каждого файла — по format_map */
  format?: string;
  format_map?: Record<string, string>;
  sourceLang?: string;
  languages: string[];
  repo?: string;
}

/**
 * Проверить карту форматов {".xml": "rimworld", ".png": "-", "*": "plain-lines"}:
 * ключи — расширения с точкой (приводятся к нижнему регистру) или «*», значения — существующий формат или «-».
 */
async function cleanFormatMap(raw: unknown): Promise<Record<string, string>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'format_map: объект { ".xml": "rimworld", ".png": "-" }');
  const out: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 200) fail(400, 'format_map: слишком много расширений');
  for (const [k0, v] of entries) {
    const k = String(k0).trim().toLowerCase();
    if (!isMapKey(k)) fail(400, `format_map: «${k0}» — нужно расширение вида ".xml" или "*"`);
    if (typeof v !== 'string' || (v !== PASSTHROUGH && !(await resolveFormat(v)))) fail(400, `format_map: неизвестный формат «${String(v)}» для ${k}`);
    out[k] = v as string;
  }
  return out;
}

async function upsertGame(meta: GameMeta, rules: Record<string, Rule[]> = {}): Promise<Game> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(meta.slug ?? '')) fail(400, 'slug: латиница в нижнем регистре, цифры и дефис');
  if (meta.format && !(await resolveFormat(meta.format))) fail(400, `Неизвестный формат ${meta.format}`);
  // карта из game.json дополняет карту на форуме (её записи главнее), остальные расширения остаются как были
  const map = meta.format_map !== undefined ? await cleanFormatMap(meta.format_map) : {};
  if (!Array.isArray(meta.languages) || !meta.languages.length) fail(400, 'languages: непустой список');
  const [g] = await db()<Game[]>`
    insert into games (slug, title, format, format_map, source_lang, languages, repo, rules)
    values (${meta.slug}, ${meta.title ?? meta.slug}, ${meta.format || ''}, ${db().json(map as never)}, ${meta.sourceLang ?? 'en'},
            ${meta.languages}, ${meta.repo ?? null}, ${db().json(rules as never)})
    on conflict (slug) do update set
      title = excluded.title, format = coalesce(${meta.format || null}, games.format), source_lang = excluded.source_lang,
      format_map = games.format_map || excluded.format_map,
      languages = excluded.languages, repo = coalesce(excluded.repo, games.repo), rules = excluded.rules,
      updated_at = now()
    returning id, slug, title, repo, format, format_map, source_lang, languages, rules`;
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
  const b = await body<{ slug: string; title: string; format?: string; format_map?: Record<string, string>; sourceLang?: string; languages: string[]; repo?: string; description?: string; links?: unknown; cover_url?: string }>(c);
  const slug = String(b.slug ?? '').trim();
  const title = String(b.title ?? '').trim();
  const sourceLang = String(b.sourceLang ?? 'en').trim() || 'en';
  if (!SLUG_RE.test(slug)) fail(400, 'Адрес: латиница в нижнем регистре, цифры и дефис');
  if (!title || title.length > 200) fail(400, 'Укажите название игры');
  // Формат каждого файла выбирается по расширению при загрузке; format — необязательный формат по умолчанию
  if (b.format && !(await resolveFormat(String(b.format)))) fail(400, 'Неизвестный формат файлов');
  const formatMap = b.format_map !== undefined ? await cleanFormatMap(b.format_map) : {};
  if (!LANG_RE.test(sourceLang)) fail(400, 'Неверный код языка оригинала');
  const languages = cleanLanguages(b.languages, sourceLang);
  const repo = b.repo?.trim() || null;
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(400, 'Репозиторий: owner/name');
  const info = cleanInfo(b);
  const sql = db();
  const created = await sql.begin(async (tx) => {
    const [g] = await tx<{ id: number }[]>`
      insert into games (slug, title, format, format_map, source_lang, languages, repo, created_by, description, links, cover_url)
      values (${slug}, ${title}, ${b.format ? String(b.format) : ''}, ${sql.json(formatMap as never)}, ${sourceLang}, ${languages}, ${repo}, ${user.id},
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
  // Кодировки оригиналов (сколько файлов в какой) и какие кодировки не подходят языкам перевода
  const fileEncodings = await db()<{ encoding: string; files: number }[]>`
    select encoding, count(*)::int as files from source_files where game_id = ${game.id} and data is null group by encoding order by files desc, encoding`;
  return c.json({ game, moderators, ...files, fileEncodings, encodingSupport: encodingSupport(game.languages), encodingList: ENCODINGS });
});

/** Изменить название, языки, репозиторий, правила проверок. */
app.post('/games/:slug/settings', async (c) => {
  const { game } = await requireManager(c);
  const b = await body<{
    title?: string; languages?: string[]; repo?: string | null; rules?: Record<string, Rule[]>; format?: string; format_map?: Record<string, string>;
    description?: string | null; links?: unknown; cover_url?: string | null; force?: boolean; encodings?: Record<string, string | null>;
  }>(c);
  // Формат по умолчанию и карта «расширение → формат» меняются в любой момент: уже разобранные файлы
  // остаются в прежнем формате (source_files.format), пока не нажать «Пересчитать строки» (/reparse).
  let format = game.format;
  if (b.format !== undefined && b.format !== game.format) {
    if (b.format && !(await resolveFormat(String(b.format)))) fail(400, 'Неизвестный формат');
    format = String(b.format ?? '');
  }
  const formatMap = b.format_map !== undefined ? await cleanFormatMap(b.format_map) : game.format_map ?? {};
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
  // Кодировки выгрузки по языкам: {язык: кодировка}; пустое значение — «как в оригинале». Передаётся целиком.
  let encodings = game.encodings ?? {};
  if (b.encodings !== undefined) {
    if (!b.encodings || typeof b.encodings !== 'object' || Array.isArray(b.encodings)) fail(400, 'encodings: объект { "ru": "windows-1251" }');
    encodings = {};
    for (const [l, e] of Object.entries(b.encodings)) {
      if (!e) continue;
      if (!languages.includes(l)) fail(400, `encodings: языка ${l} нет в игре`);
      if (!isEncoding(e)) fail(400, `Неизвестная кодировка ${e}. Доступны: ${ENCODINGS.join(', ')}`);
      encodings[l] = e;
    }
  }
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
      format_map = ${db().json(formatMap as never)},
      rules = ${db().json(rules as never)},
      description = ${info.description !== undefined ? info.description : game.description ?? null},
      links = ${db().json((info.links ?? game.links ?? []) as never)},
      cover_url = ${info.cover_url !== undefined ? info.cover_url : game.cover_url ?? null},
      encodings = ${db().json(encodings as never)},
      updated_at = now()
    where id = ${game.id}`;
  // Сколько сохранённых оригиналов разобрано не тем форматом, что теперь задан в карте, — их пересчитает /reparse
  const parsed = await db()<{ path: string; format: string | null }[]>`select path, format from source_files where game_id = ${game.id}`;
  const reparse = parsed.filter((f) => (fileFormat({ format, format_map: formatMap }, f.path) ?? PASSTHROUGH) !== (f.format ?? format)).length;
  return c.json({ ok: true, format_map: formatMap, reparse });
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

// ---------- оригинальные файлы: список, скачивание, удаление в корзину и возврат ----------

/** Оригиналы игры: путь, формат разбора, кодировка, размер (байт), строк; trash — файлы в корзине (вернуть можно 30 дней). */
app.get('/games/:slug/source/files', async (c) => {
  const { game } = await requireManager(c);
  const files = await db()`
    select f.path, f.format, f.encoding, coalesce(octet_length(f.data), octet_length(f.content))::int as size,
      (select count(*) from strings s where s.game_id = f.game_id and s.file = f.path and not s.removed)::int as strings,
      f.updated_at
    from source_files f where f.game_id = ${game.id} order by f.path`;
  const trash = await db()`
    select t.path, t.format, coalesce(octet_length(t.data), octet_length(t.content))::int as size, t.deleted_at, u.login as deleted_by
    from source_files_trash t left join users u on u.id = t.deleted_by
    where t.game_id = ${game.id} and t.deleted_at > now() - make_interval(days => ${TRASH_DAYS}) order by t.deleted_at desc, t.path`;
  return c.json({ files, trash, trashDays: TRASH_DAYS });
});

/** Скачать оригинал байт в байт (текст — в его исходной кодировке, с BOM). */
app.get('/games/:slug/source/raw', async (c) => {
  const { game } = await requireManager(c);
  const path = c.req.query('path') ?? '';
  const [f] = await db()<{ content: string; encoding: string; data: Buffer | null }[]>`
    select content, encoding, data from source_files where game_id = ${game.id} and path = ${path}`;
  if (!f) fail(404, 'Файл не найден');
  const bytes = f!.data ? new Uint8Array(f!.data) : encodeText(f!.content, f!.encoding);
  const name = path.split('/').pop() || 'file';
  return new Response(bytes as BodyInit, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, no-store',
    },
  });
});

const MAX_PATHS = 5000;
const cleanPaths = (v: unknown): string[] => {
  if (!Array.isArray(v) || !v.length || v.some((p) => typeof p !== 'string' || !p.trim())) fail(400, 'paths: непустой список путей файлов');
  if ((v as string[]).length > MAX_PATHS) fail(400, `paths: не больше ${MAX_PATHS} за раз`);
  return v as string[];
};

/** Удалить один оригинал: DELETE /games/:slug/source?path=… */
app.delete('/games/:slug/source', async (c) => {
  const { user, game } = await requireManager(c);
  const path = c.req.query('path');
  if (!path) fail(400, 'Укажите path');
  return c.json(await deleteSource(game, { paths: [path!] }, user.id));
});

/** Удалить несколько оригиналов: {paths: [...]} или всю папку {prefix: "Scripts/"}. */
app.post('/games/:slug/source/delete', async (c) => {
  const { user, game } = await requireManager(c);
  const b = await body<{ paths?: string[]; prefix?: string }>(c);
  if (b.prefix !== undefined) {
    if (typeof b.prefix !== 'string' || !b.prefix.trim()) fail(400, 'prefix: начало пути, например "Scripts/"');
    return c.json(await deleteSource(game, { prefix: b.prefix }, user.id));
  }
  return c.json(await deleteSource(game, { paths: cleanPaths(b.paths) }, user.id));
});

/** Вернуть удалённые оригиналы из корзины (строки возвращаются со своими вариантами и утверждениями). */
app.post('/games/:slug/source/restore', async (c) => {
  const { game } = await requireManager(c);
  const b = await body<{ paths?: string[] }>(c);
  return c.json(await restoreSource(game, cleanPaths(b.paths)));
});

/** Пересобрать строки из сохранённых оригиналов по текущему описанию формата (после правки формата). */
app.post('/games/:slug/reparse', async (c) => {
  const { game } = await requireManager(c);
  // Формат каждого файла — по текущей карте форматов; файлы «как есть» передаются своими байтами
  const rows = await db()<{ path: string; content: string; encoding: string; data: Buffer | null }[]>`
    select path, content, encoding, data from source_files where game_id = ${game.id}`;
  if (!rows.length) fail(422, 'Оригиналы не сохранены — загрузите исходные файлы заново');
  const files: InFile[] = rows.map((r) => ({ path: r.path, content: r.content, encoding: r.encoding, data: r.data ? new Uint8Array(r.data) : null }));
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
  const games = await db()<{ slug: string }[]>`
    select slug from games where format = ${slug} or exists (select 1 from jsonb_each_text(format_map) m where m.value = ${slug})`;
  return c.json({ ok: true, games: games.map((g) => g.slug) });
});


// ---------- «Опубликовать в GitHub» ----------

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$/;
const jwtKey = () => new TextEncoder().encode(env('JWT_SECRET'));

/** Начать публикацию: вернуть ссылку на GitHub, где пользователь разрешит запись в публичные репо (один раз, токен не хранится). */
app.post('/games/:slug/publish/start', async (c) => {
  const { user, game } = await requireManager(c);
  const b = await body<{ version?: string; return?: string; langs?: string[] }>(c);
  const version = String(b.version ?? '').trim();
  if (version && !VERSION_RE.test(version)) fail(400, 'Версия: латиница, цифры, точки и дефисы, например 1.0 или 1.6.2');
  // Публикуются только выбранные языки — папки остальных в репо не меняются
  const langs = Array.isArray(b.langs) ? [...new Set(b.langs.map(String))] : [];
  if (!langs.length) fail(400, 'Выберите хотя бы один язык для публикации');
  const unknown = langs.filter((l) => !game.languages.includes(l));
  if (unknown.length) fail(400, `Языков ${unknown.join(', ')} нет в игре`);
  if (!game.repo) fail(400, 'Сначала укажите репозиторий (owner/name) и сохраните настройки');
  const ret = b.return ?? '';
  if (!allowedReturn(ret, c.req.url)) fail(400, 'Недопустимый адрес возврата');
  const state = await new SignJWT({ typ: 'publish', gid: game.id, uid: user.id, ver: version, langs, ret })
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

type PublishState = { gid: number; uid: number; ver: string; langs?: string[]; ret: string };

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
  const [g] = await db()<Game[]>`select id, slug, title, repo, format, format_map, source_lang, languages, rules, encodings from games where id = ${st.gid}`;
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
    const { publishGame } = await import('./publish.js'); // модуль публикации (zip, GitHub API) грузим только когда нужен
    const langs = (st.langs ?? g.languages).filter((l) => g.languages.includes(l));
    const result = await publishGame(g, tok.access_token, { version: st.ver || undefined, site: site.origin + site.pathname, langs });
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

// ---------- ревизии перевода ----------

/** Права на ревизию: модератор языка / управляющий игрой / админ, не забаненный. */
async function revisionScope(c: Context, undo = false) {
  const user = await requireUser(c);
  const g = await gameBySlug(c.req.param('slug')!);
  const b = await body<{ lang: string; stage?: string }>(c);
  const lang = checkLang(g, b.lang);
  if (!(await isModerator(user, g.id, lang))) fail(403, 'Новую ревизию начинают модераторы этого языка');
  await requireNotBanned(user, g.id);
  // новая ревизия начинается с «Группового перевода» или «Апрува»; отмена может вернуть любой прежний этап
  if (b.stage != null && !(undo ? STATUSES : ['open', 'review']).includes(String(b.stage) as Status))
    fail(400, 'Этап новой ревизии: open (групповой перевод) или review (апрув)');
  return { user, g, lang, stage: (b.stage ?? null) as Status | null };
}

/**
 * Новая ревизия: все утверждения языка уходят в approved_history (с текущим номером ревизии), их тексты
 * остаются вариантами (текст модератора без варианта становится вариантом от его имени), утверждения снимаются,
 * номер ревизии растёт. Этап не меняется, если не передан stage.
 */
app.post('/games/:slug/revision', async (c) => {
  const { user, g, lang, stage } = await revisionScope(c);
  const current = await langStatus(g.id, lang);
  if (current === 'done' && !stage) fail(422, 'Перевод на этапе «Готово». Укажите, с какого этапа начать новую ревизию: «Апрув» или «Групповой перевод».');
  const result = await db().begin(async (tx) => {
    await tx`insert into language_status (game_id, lang, status, updated_by) values (${g.id}, ${lang}, ${current}, ${user.id}) on conflict do nothing`;
    const [ls] = await tx<{ revision: number; status: Status }[]>`
      select revision, status from language_status where game_id = ${g.id} and lang = ${lang} for update`;
    // тексты утверждений без варианта — в варианты (автор — утвердивший модератор), чтобы переутвердить в один клик
    await tx`
      insert into variants (string_id, lang, text, author_id, ai)
      select a.string_id, a.lang, a.text, a.moderator_id, false
      from approved a join strings s on s.id = a.string_id
      where s.game_id = ${g.id} and a.lang = ${lang} and a.variant_id is null
      on conflict (string_id, lang, text) do nothing`;
    const archived = await tx`
      insert into approved_history (game_id, lang, revision, string_id, text, variant_id, source_hash, moderator_id, approved_at)
      select ${g.id}, a.lang, ${ls.revision}, a.string_id, a.text,
        coalesce(a.variant_id, (select v.id from variants v where v.string_id = a.string_id and v.lang = a.lang and v.text = a.text)),
        a.source_hash, a.moderator_id, a.approved_at
      from approved a join strings s on s.id = a.string_id
      where s.game_id = ${g.id} and a.lang = ${lang}`;
    await tx`delete from approved a using strings s where s.id = a.string_id and s.game_id = ${g.id} and a.lang = ${lang}`;
    const [next] = await tx<{ revision: number; status: Status }[]>`
      update language_status set revision = revision + 1, status = ${stage ?? ls.status}, updated_by = ${user.id}, updated_at = now()
      where game_id = ${g.id} and lang = ${lang} returning revision, status`;
    return { revision: next.revision, archived: archived.count, stage: next.status, previousStage: ls.status };
  });
  return c.json(result);
});

/** Отменить новую ревизию: вернуть утверждения прошлой, если с тех пор ничего не утверждали. stage — вернуть и этап. */
app.post('/games/:slug/revision/undo', async (c) => {
  const { user, g, lang, stage } = await revisionScope(c, true);
  const result = await db().begin(async (tx) => {
    const [ls] = await tx<{ revision: number; status: Status }[]>`
      select revision, status from language_status where game_id = ${g.id} and lang = ${lang} for update`;
    if (!ls || ls.revision <= 1) fail(409, 'Отменять нечего: это первая ревизия');
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from approved a join strings s on s.id = a.string_id where s.game_id = ${g.id} and a.lang = ${lang}`;
    if (n) fail(409, `В ревизии ${ls.revision} уже утверждено строк: ${n}. Отменить новую ревизию нельзя — иначе эти утверждения пропадут.`);
    const prev = ls.revision - 1;
    const restored = await tx`
      insert into approved (string_id, lang, text, variant_id, source_hash, moderator_id, approved_at)
      select string_id, lang, text, variant_id, source_hash, moderator_id, coalesce(approved_at, now())
      from approved_history where game_id = ${g.id} and lang = ${lang} and revision = ${prev}
      on conflict (string_id, lang) do nothing`;
    await tx`delete from approved_history where game_id = ${g.id} and lang = ${lang} and revision = ${prev}`;
    const [next] = await tx<{ revision: number; status: Status }[]>`
      update language_status set revision = ${prev}, status = ${stage ?? ls.status}, updated_by = ${user.id}, updated_at = now()
      where game_id = ${g.id} and lang = ${lang} returning revision, status`;
    return { revision: next.revision, restored: restored.count, stage: next.status };
  });
  return c.json(result);
});
