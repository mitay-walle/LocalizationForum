// MCP-сервер форума (Streamable HTTP, без сессий): /api/mcp
// Инструменты вызывают тот же REST API от имени пользователя, поэтому права и проверки — те же, что на сайте.
// Все варианты, предложенные через MCP, помечаются как ИИ (заголовок x-client: mcp).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { userByApiToken } from './auth.js';
import { origin } from './oauth.js';
import { variantLimits } from './limits.js';

const instructions = (L = variantLimits()) => `LocalizationForum — коллективный перевод игр: участники предлагают варианты строк, голосуют, модераторы утверждают.
Правила для переводов:
- сохраняйте плейсхолдеры, теги и переводы строк из оригинала ({0}, {PAWN_label}, %d, <color=…>, \\n) — иначе вариант не примется;
- учитывайте context строки (кто говорит, где строка в игре) и уже утверждённые переводы соседних строк для единообразия терминов;
- ваши варианты публикуются от имени пользователя и помечаются на сайте значком «ИИ»; финальное решение принимают модераторы;
- не предлагайте вариант, если уже есть хороший — лучше проголосуйте за него;
- у каждого языка есть этап: «Групповой перевод» (open), «Апрув» (review — предлагать и голосовать могут только модераторы), «Готово» (done — изменения закрыты);
- лимиты против спама (модераторы языка не ограничены): не больше ${L.perUserString} своих вариантов на строку и ${L.perString} вариантов на строку всего, не больше ${L.perHour} вариантов в час; при ошибке 429 подождите, а не повторяйте сразу. Забаненный пользователь может только читать.
Управление играми (create_game, update_game_info, add_language/remove_language, set_format_map, reparse_game, upload/delete/restore/list_source_files):
- создать игру может любой вошедший — он становится её владельцем; остальное — только управляющий игрой (владелец, модератор всех языков, администратор);
- формат каждого файла выбирается по расширению (format_map, «-» — не переводить, копировать как есть); после set_format_map вызовите reparse_game;
- оригиналы загружайте пачками не больше ${MCP_UPLOAD_MB} МБ за вызов (текст — content, двоичные файлы — base64); удалённые файлы 30 дней лежат в корзине и возвращаются restore_source_files вместе с переводами;
- не удаляйте файлы и языки без явной просьбы пользователя.`;

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: any }>;

/** Предел одной пачки upload_source_files (тело запроса на Vercel ≤ ~4.5 МБ). */
const MCP_UPLOAD_MB = 3;
const linkSchema = z.array(z.object({ kind: z.enum(['steam', 'site', 'gog', 'itch', 'other']), url: z.string().url(), title: z.string().optional() }));

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] });
const failText = (msg: string) => ({ ...text(msg), isError: true });

function buildServer(call: Call, login: string) {
  const server = new McpServer({ name: 'localization-forum', version: '1.0.0' }, { instructions: instructions() });
  const guard = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    if (r.status >= 400) throw new Error(r.data?.error ? `${r.data.error}${r.data.issues ? ': ' + r.data.issues.map((i: any) => i.message).join('; ') : ''}` : `HTTP ${r.status}`);
    return r.data;
  };
  const tool = <S extends z.ZodRawShape>(name: string, title: string, description: string, shape: S, run: (a: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>, readOnly = false) =>
    server.registerTool(
      name,
      { title, description, inputSchema: shape, annotations: { readOnlyHint: readOnly, openWorldHint: false } },
      (async (args: any) => {
        try {
          return text(await run(args));
        } catch (e) {
          return failText((e as Error).message);
        }
      }) as any,
    );

  tool('whoami', 'Кто я', 'Текущий пользователь форума и игры/языки, где он модератор.', {}, async () => ({ login, ...(await guard('GET', '/api/me')) }), true);

  tool('list_games', 'Список игр', 'Все игры на форуме: slug, название, формат, языки, число строк и утверждённых переводов по языкам.', {}, async () => (await guard('GET', '/api/games')).games, true);

  tool(
    'get_game',
    'Игра',
    'Сводка по игре: языки и статистика (утверждено / на голосовании / устарело / всего), этап и номер ревизии перевода каждого языка (status[lang].status / .revision), можно ли мне управлять игрой. Форматы файлов — по расширению: game.format_map ({".xml": "rimworld", ".png": "-"}, «-» — файл не переводится, копируется как есть) и formats (расширение, формат, файлов, строк).',
    { game: z.string().describe('slug игры') },
    async ({ game }) => guard('GET', `/api/games/${encodeURIComponent(game)}`),
    true,
  );

  tool(
    'find_strings',
    'Найти строки',
    'Строки игры с оригиналом, контекстом, утверждённым переводом и вариантами (id, текст, голоса, автор, ai). По 50 на страницу. Для перевода берите filter=untranslated.',
    {
      game: z.string().describe('slug игры'),
      lang: z.string().describe('код языка перевода, например ru'),
      filter: z.enum(['all', 'untranslated', 'voting', 'approved', 'stale']).default('untranslated'),
      query: z.string().optional().describe('поиск по ключу, оригиналу или переводу'),
      file: z.string().optional().describe('только строки из этого файла'),
      page: z.number().int().min(1).default(1),
    },
    async ({ game, lang, filter, query, file, page }) => {
      const qs = new URLSearchParams({ lang, filter, page: String(page) });
      if (query) qs.set('q', query);
      if (file) qs.set('file', file);
      const d = await guard('GET', `/api/games/${encodeURIComponent(game)}/strings?${qs}`);
      return {
        page: d.page,
        pages: Math.ceil(d.total / d.pageSize),
        total: d.total,
        canModerate: d.canModerate,
        stage: d.status, // open — групповой перевод, review — апрув (варианты/голоса только у модераторов), done — заморожен
        revision: d.revision, // номер ревизии перевода: новая ревизия снимает все утверждения, их тексты остаются вариантами
        strings: d.strings.map((s: any) => ({
          id: s.id,
          file: s.file,
          key: s.key,
          source: s.source,
          context: s.context ?? undefined,
          approved: s.approved_text ?? undefined,
          stale: s.stale || undefined,
          variants: s.variants.map((v: any) => ({ id: v.id, text: v.text, votes: v.votes, author: v.author, ai: v.ai || undefined, mine: v.mine || undefined, was_approved_in_revision: v.was_approved_rev ?? undefined })),
        })),
      };
    },
    true,
  );

  tool(
    'list_files',
    'Файлы игры',
    'Файлы игры и прогресс перевода по каждому: approved — утверждено, voting — строк с вариантами без утверждения, total — всего.',
    { game: z.string(), lang: z.string() },
    async ({ game, lang }) => (await guard('GET', `/api/games/${encodeURIComponent(game)}/files?lang=${encodeURIComponent(lang)}`)).files,
    true,
  );

  tool(
    'check_translation',
    'Проверить перевод',
    'Проверить вариант перевода без сохранения: плейсхолдеры, правила языка, ограничения формата файла этой строки (например, у построчных форматов перевод — в одну строку).',
    { string_id: z.number().int(), lang: z.string(), text: z.string() },
    async ({ string_id, lang, text: t }) => guard('POST', `/api/strings/${string_id}/variants`, { lang, text: t, check: true }),
    true,
  );

  tool(
    'propose_translations',
    'Предложить переводы',
    'Предложить варианты перевода (до 50 за раз). Каждый проверяется как на сайте; варианты помечаются как ИИ. Возвращает результат по каждой строке.',
    {
      lang: z.string(),
      items: z
        .array(z.object({ string_id: z.number().int(), text: z.string().min(1) }))
        .min(1)
        .max(50),
    },
    async ({ lang, items }) => {
      const results = [];
      for (const it of items) {
        const r = await call('POST', `/api/strings/${it.string_id}/variants`, { lang, text: it.text });
        results.push(
          r.status < 300
            ? { string_id: it.string_id, ok: true, variant_id: r.data.id, warnings: r.data.issues?.map((i: any) => i.message) }
            : { string_id: it.string_id, ok: false, error: r.data?.error, issues: r.data?.issues?.map((i: any) => i.message) },
        );
      }
      return { proposed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
    },
  );

  tool(
    'vote',
    'Голосовать',
    'Поставить (vote=true) или снять (vote=false) свой голос за вариант. У строки на одном языке голос может быть только за один вариант: новый голос снимает прежний (их id — в cleared).',
    { variant_id: z.number().int(), vote: z.boolean().default(true) },
    async ({ variant_id, vote }) => guard(vote ? 'POST' : 'DELETE', `/api/variants/${variant_id}/vote`),
  );

  tool(
    'approve_translation',
    'Утвердить перевод',
    'Только для модераторов: утвердить вариант (variant_id) или свой текст (text) как итоговый перевод строки.',
    { string_id: z.number().int(), lang: z.string(), variant_id: z.number().int().optional(), text: z.string().optional() },
    async ({ string_id, lang, variant_id, text: t }) => {
      if (!variant_id && !t) throw new Error('Укажите variant_id или text');
      return guard('POST', `/api/strings/${string_id}/approve`, { lang, variantId: variant_id, text: t });
    },
  );

  // ---------- управление играми ----------
  const g = (game: string) => `/api/games/${encodeURIComponent(game)}`;

  tool(
    'create_game',
    'Создать игру',
    'Создать новую игру на форуме (вы станете её владельцем). slug — адрес: латиница в нижнем регистре, цифры, дефис. languages — языки перевода (коды вроде ru, uk, pt-BR), без языка оригинала. Формат файлов выбирать не нужно — он определится по расширениям при upload_source_files.',
    {
      slug: z.string().describe('адрес игры, например my-game'),
      title: z.string(),
      source_lang: z.string().default('en').describe('язык оригинала'),
      languages: z.array(z.string()).min(1).describe('языки перевода'),
      description: z.string().optional(),
      links: linkSchema.optional().describe('ссылки: steam / site / gog / itch / other'),
      cover_url: z.string().optional().describe('картинка-обложка (https)'),
      repo: z.string().optional().describe('GitHub-репозиторий перевода owner/name'),
    },
    async ({ slug, title, source_lang, languages, description, links, cover_url, repo }) =>
      guard('POST', '/api/games', { slug, title, sourceLang: source_lang, languages, description, links, cover_url, repo }),
  );

  tool(
    'update_game_info',
    'Изменить игру',
    'Изменить сведения об игре — только переданные поля: название, описание, ссылки (заменяют все прежние), обложку, репозиторий, список языков перевода (целиком; языки с утверждёнными переводами убираются только с force=true).',
    {
      game: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      links: linkSchema.optional(),
      cover_url: z.string().optional(),
      repo: z.string().optional(),
      languages: z.array(z.string()).optional(),
      force: z.boolean().optional().describe('подтвердить удаление языков с утверждёнными переводами'),
    },
    async ({ game, ...fields }) => {
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).filter((k) => k !== 'force').length) throw new Error('Передайте хотя бы одно поле для изменения');
      await guard('POST', `${g(game)}/settings`, body);
      return (await guard('GET', g(game))).game;
    },
  );

  const setLanguages = async (game: string, change: (langs: string[]) => string[], force?: boolean) => {
    const cur: string[] = (await guard('GET', g(game))).game.languages;
    const languages = change(cur);
    await guard('POST', `${g(game)}/settings`, { languages, force: !!force });
    return { languages };
  };
  tool(
    'add_language',
    'Добавить язык',
    'Добавить язык перевода в игру (код языка, например uk или pt-BR).',
    { game: z.string(), lang: z.string() },
    async ({ game, lang }) => setLanguages(game, (l) => (l.includes(lang) ? l : [...l, lang])),
  );
  tool(
    'remove_language',
    'Убрать язык',
    'Убрать язык перевода из игры. Если у языка есть утверждённые переводы, нужен force=true (переводы сохранятся, но будут скрыты). Только по явной просьбе пользователя.',
    { game: z.string(), lang: z.string(), force: z.boolean().optional() },
    async ({ game, lang, force }) => setLanguages(game, (l) => l.filter((x) => x !== lang), force),
  );

  tool(
    'set_format_map',
    'Форматы файлов',
    'Задать формат по расширению файла: {".xml": "rimworld", ".json": "json-nested", ".gpc": "gunpoint", ".png": "-"}; «-» — не переводить, копировать как есть; "*" — для остальных расширений. Карта передаётся целиком. Список форматов — GET /api/formats (встроенные: rimworld, json, json-nested, gunpoint, properties, plain-lines). После смены вызовите reparse_game.',
    { game: z.string(), format_map: z.record(z.string()) },
    async ({ game, format_map }) => guard('POST', `${g(game)}/settings`, { format_map }),
  );

  tool(
    'reparse_game',
    'Пересчитать строки',
    'Заново разобрать все загруженные оригиналы по текущей карте форматов. Утверждённые переводы сохраняются там, где ключ и оригинал строки не изменились.',
    { game: z.string() },
    async ({ game }) => guard('POST', `${g(game)}/reparse`),
  );

  tool(
    'list_source_files',
    'Оригинальные файлы',
    'Оригинальные файлы игры: путь, формат разбора («-» — копируется как есть), кодировка, размер в байтах, число строк; trash — удалённые файлы, которые можно вернуть.',
    { game: z.string() },
    async ({ game }) => guard('GET', `${g(game)}/source/files`),
    true,
  );

  tool(
    'upload_source_files',
    'Загрузить оригиналы',
    `Загрузить или обновить оригинальные файлы игры (пути — относительно папки оригинала, например Scripts/Intro.gpc). Текстовый файл — content (+ encoding, по умолчанию utf-8), двоичный (картинка и т. п.) — base64. Не больше ${MCP_UPLOAD_MB} МБ за вызов — большие наборы делите на несколько вызовов. Изменённые строки помечают переводы устаревшими. replace=true — этот вызов содержит ВСЕ файлы игры: остальные будут удалены (в корзину).`,
    {
      game: z.string(),
      files: z
        .array(z.object({ path: z.string().min(1), content: z.string().optional(), base64: z.string().optional(), encoding: z.string().optional() }))
        .min(1)
        .max(500),
      replace: z.boolean().default(false),
    },
    async ({ game, files, replace }) => {
      const size = files.reduce((n, f) => n + (f.base64?.length ?? Buffer.byteLength(f.content ?? '')) + f.path.length, 0);
      if (size > MCP_UPLOAD_MB * 1_000_000) throw new Error(`Пачка ${(size / 1e6).toFixed(1)} МБ больше ${MCP_UPLOAD_MB} МБ — разделите файлы на несколько вызовов`);
      const bad = files.find((f) => (f.content === undefined) === (f.base64 === undefined));
      if (bad) throw new Error(`${bad.path}: укажите content (текст) или base64 (байты)`);
      return guard('POST', `${g(game)}/source`, {
        files: files.map((f) => (f.base64 !== undefined ? { path: f.path, content: '', data: f.base64 } : { path: f.path, content: f.content, encoding: f.encoding })),
        paths: replace ? files.map((f) => f.path) : undefined,
      });
    },
  );

  tool(
    'delete_source_files',
    'Удалить оригиналы',
    'Удалить оригинальные файлы игры (в корзину на 30 дней): их строки скрываются, варианты и утверждения сохраняются и вернутся при restore_source_files. Только по явной просьбе пользователя.',
    { game: z.string(), paths: z.array(z.string()).min(1).max(5000) },
    async ({ game, paths }) => guard('POST', `${g(game)}/source/delete`, { paths }),
  );

  tool(
    'restore_source_files',
    'Вернуть оригиналы',
    'Вернуть удалённые оригиналы из корзины: строки возвращаются вместе с вариантами и утверждениями. Пути — из list_source_files → trash.',
    { game: z.string(), paths: z.array(z.string()).min(1).max(5000) },
    async ({ game, paths }) => guard('POST', `${g(game)}/source/restore`, { paths }),
  );

  tool(
    'set_stage',
    'Сменить этап перевода',
    'Только для модераторов языка: open — «Групповой перевод» (все предлагают и голосуют), review — «Апрув» (модераторы утверждают итог), done — «Готово» (перевод заморожен).',
    { game: z.string(), lang: z.string(), stage: z.enum(['open', 'review', 'done']) },
    async ({ game, lang, stage }) => guard('POST', `/api/games/${encodeURIComponent(game)}/status`, { lang, status: stage }),
  );

  return server;
}

/**
 * Обработчик /api/mcp. Токен: Authorization: Bearer lf_… или ?token=lf_… (для клиентов без заголовков).
 * Модуль подключается динамически из server.ts — MCP SDK и zod не разбираются при холодном старте обычного API.
 */
export async function mcpHandler(c: Context, app: Hono) {
  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : c.req.query('token') ?? '';
  const user = token.startsWith('lf_') ? await userByApiToken(token) : null;
  if (!user) {
    return c.json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'Нужна авторизация: подключите коннектор через OAuth или передайте токен с сайта (страница «Токены»).' }, id: null },
      401,
      { 'WWW-Authenticate': `Bearer resource_metadata="${origin(c)}/.well-known/oauth-protected-resource"` },
    );
  }
  const call: Call = async (method, path, body) => {
    const res = await app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-client': 'mcp' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = { error: raw.slice(0, 200) };
    }
    return { status: res.status, data };
  };
  const server = buildServer(call, user.login);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
}
