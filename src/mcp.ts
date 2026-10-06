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
- лимиты против спама (модераторы языка не ограничены): не больше ${L.perUserString} своих вариантов на строку и ${L.perString} вариантов на строку всего, не больше ${L.perHour} вариантов в час; при ошибке 429 подождите, а не повторяйте сразу. Забаненный пользователь может только читать.`;

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: any }>;

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
    'Сводка по игре: языки и статистика (утверждено / на голосовании / устарело / всего), этап перевода каждого языка (status), можно ли мне управлять игрой.',
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
        strings: d.strings.map((s: any) => ({
          id: s.id,
          file: s.file,
          key: s.key,
          source: s.source,
          context: s.context ?? undefined,
          approved: s.approved_text ?? undefined,
          stale: s.stale || undefined,
          variants: s.variants.map((v: any) => ({ id: v.id, text: v.text, votes: v.votes, author: v.author, ai: v.ai || undefined, mine: v.mine || undefined })),
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
    'Проверить вариант перевода без сохранения: плейсхолдеры, правила языка, ограничения формата файла.',
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

  tool(
    'set_stage',
    'Сменить этап перевода',
    'Только для модераторов языка: open — «Групповой перевод» (все предлагают и голосуют), review — «Апрув» (модераторы утверждают итог), done — «Готово» (перевод заморожен).',
    { game: z.string(), lang: z.string(), stage: z.enum(['open', 'review', 'done']) },
    async ({ game, lang, stage }) => guard('POST', `/api/games/${encodeURIComponent(game)}/status`, { lang, status: stage }),
  );

  return server;
}

/** Обработчик /api/mcp. Токен: Authorization: Bearer lf_… или ?token=lf_… (для клиентов без заголовков). */
export function mountMcp(root: Hono, app: Hono) {
  const handler = async (c: Context) => {
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
  };
  root.all('/api/mcp', handler);
}
