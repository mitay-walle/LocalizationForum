// «Опубликовать в GitHub»: одним коммитом выложить в репо игры оригиналы, переводы выбранных языков и game.json,
// при необходимости создать репо и выпустить Release с zip для каждого выбранного языка.
// Папки остальных языков не трогаются: коммит строится поверх текущего дерева репо (base_tree).
// GitHub-токен с правом public_repo запрашивается у пользователя на один раз и нигде не хранится.
import { db } from './db.js';
import { makeZip } from './zip.js';
import { exportLanguage, outBytes, type Game } from './sync.js';
import { readme } from './readme.js';
import { encodeText } from './encoding.js';

const GH = 'https://api.github.com';

/** Итог по языку: committed — обновлён в репо (версия не указана); released — выпущен релиз;
 *  exists — тег уже есть (папка обновлена, релиз не создан); skipped — нет утверждённых строк; error — релиз не удался. */
export interface LangResult {
  lang: string;
  status: 'committed' | 'released' | 'exists' | 'skipped' | 'error';
  tag?: string;
  error?: string;
}

export interface PublishResult {
  repo: string;
  created: boolean;
  commit: string | null;
  files: number;
  releases: string[];
  langs: LangResult[];
  url: string;
}

async function gh(token: string, method: string, path: string, body?: unknown, raw?: { contentType: string; data: Uint8Array; base?: string }) {
  const res = await fetch((raw?.base ?? GH) + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'loc-forum',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(raw ? { 'Content-Type': raw.contentType } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: raw ? new Blob([raw.data as BlobPart]) : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

function ghError(what: string, r: { status: number; data: any }): never {
  const detail = r.data?.errors?.map((e: any) => e.message || e.code).join('; ');
  throw new Error(`${what}: GitHub ответил ${r.status} ${r.data?.message ?? ''}${detail ? ' (' + detail + ')' : ''}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function publishGame(game: Game, token: string, opts: { version?: string; site: string; langs?: string[] }): Promise<PublishResult> {
  // Какие языки публикуем; по умолчанию — все
  const langs = [...new Set(opts.langs ?? game.languages)];
  if (!langs.length) throw new Error('Выберите хотя бы один язык для публикации');
  const unknown = langs.filter((l) => !game.languages.includes(l));
  if (unknown.length) throw new Error(`Языков ${unknown.join(', ')} нет в игре`);
  if (!game.repo || !/^[\w.-]+\/[\w.-]+$/.test(game.repo)) throw new Error('В настройках игры не указан репозиторий вида owner/name');
  const [owner, name] = game.repo.split('/');

  // 1. Репозиторий: найти или создать
  let created = false;
  let repo = await gh(token, 'GET', `/repos/${owner}/${name}`);
  if (repo.status === 404) {
    const me = await gh(token, 'GET', '/user');
    if (me.status !== 200) ghError('Не удалось узнать пользователя GitHub', me);
    const body = { name, description: `Перевод ${game.title} — LocalizationForum`, auto_init: true, has_wiki: false };
    const mine = String(me.data.login).toLowerCase() === owner.toLowerCase();
    const res = await gh(token, 'POST', mine ? '/user/repos' : `/orgs/${owner}/repos`, body);
    if (res.status === 404 && !mine)
      throw new Error(`Нет такого пользователя или организации «${owner}» (вы вошли как ${me.data.login}). Проверьте поле «Репозиторий».`);
    if (res.status >= 300) ghError('Не удалось создать репозиторий', res);
    created = true;
    repo = res;
  } else if (repo.status !== 200) ghError('Не удалось открыть репозиторий', repo);
  if (repo.data.permissions && !repo.data.permissions.push) throw new Error(`У вашего аккаунта GitHub нет права записи в ${game.repo}`);
  const branch: string = repo.data.default_branch || 'main';

  // 2. Последний коммит ветки (у только что созданного репо он появляется не сразу)
  let ref: { status: number; data: any } = { status: 0, data: null };
  for (let i = 0; i < 8; i++) {
    ref = await gh(token, 'GET', `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (ref.status === 200) break;
    await sleep(800);
  }
  if (ref.status !== 200) ghError('Не удалось прочитать ветку', ref);
  const parent: string = ref.data.object.sha;
  const parentCommit = await gh(token, 'GET', `/repos/${owner}/${name}/git/commits/${parent}`);
  if (parentCommit.status !== 200) ghError('Не удалось прочитать коммит', parentCommit);
  const baseTree: string = parentCommit.data.tree.sha;

  // 3. Файлы
  // Файлы в UTF-8 без BOM уходят в дерево текстом; остальные (другая кодировка, BOM, файлы «как есть» — картинки и т. п.)
  // — точными байтами через blob в base64
  type PubFile = { path: string; content: string; encoding: string; data?: Uint8Array };
  const files: PubFile[] = [];
  const sources = await db()<{ path: string; content: string; encoding: string; data: Buffer | null }[]>`
    select path, content, encoding, data from source_files where game_id = ${game.id} order by path`;
  // оригиналы — в их собственной кодировке (или исходными байтами)
  for (const f of sources) files.push({ path: `source/${f.path}`, content: f.content, encoding: f.encoding, data: f.data ? new Uint8Array(f.data) : undefined });
  const exports = new Map<string, PubFile[]>();
  for (const lang of langs) {
    const ex = await exportLanguage(game, lang);
    // Языки без единого утверждённого перевода в репо кладём (полные файлы с оригиналом), но релиз не выпускаем
    exports.set(lang, ex.translated ? ex.files : []);
    for (const f of ex.files) files.push({ ...f, path: `${lang}/${f.path}` });
  }
  files.push({
    encoding: 'utf-8',
    path: 'game.json',
    content:
      JSON.stringify(
        { slug: game.slug, title: game.title, format: game.format, format_map: game.format_map ?? {}, sourceLang: game.source_lang, languages: game.languages, forum: opts.site },
        null,
        2,
      ) + '\n',
  });
  // README для игроков генерируется заново при каждой публикации (контент детерминирован — без изменений коммита не будет)
  files.push({ path: 'README.md', content: readme(game, opts.site), encoding: 'utf-8' });

  // 4. Дерево пачками по ~2 МБ (у GitHub ограничение на размер запроса), каждая пачка поверх предыдущей
  let tree = baseTree;
  let chunk: typeof files = [];
  let size = 0;
  // Блобы создаём по одному — у GitHub есть ограничения на параллельные запросы записи
  const treeEntries = async (list: PubFile[]) => {
    const out = [];
    for (const f of list) {
      if (!f.data && f.encoding === 'utf-8') {
        out.push({ path: f.path, mode: '100644', type: 'blob', content: f.content });
        continue;
      }
      const blob = await gh(token, 'POST', `/repos/${owner}/${name}/git/blobs`, { content: Buffer.from(outBytes(f, encodeText)).toString('base64'), encoding: 'base64' });
      if (blob.status >= 300) ghError('Не удалось записать файл', blob);
      out.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.data.sha as string });
    }
    return out;
  };
  const flush = async () => {
    if (!chunk.length) return;
    const r = await gh(token, 'POST', `/repos/${owner}/${name}/git/trees`, {
      base_tree: tree,
      tree: await treeEntries(chunk),
    });
    if (r.status >= 300) ghError('Не удалось записать файлы', r);
    tree = r.data.sha;
    chunk = [];
    size = 0;
  };
  for (const f of files) {
    const s = (f.data ? Math.ceil(f.data.length * 1.34) : Buffer.byteLength(f.content)) + f.path.length + 64;
    if (size + s > 2_000_000) await flush();
    chunk.push(f);
    size += s;
  }
  await flush();

  // 5. Коммит (если что-то изменилось)
  let commit: string | null = null;
  if (tree !== baseTree) {
    const c = await gh(token, 'POST', `/repos/${owner}/${name}/git/commits`, {
      message: `Перевод: публикация с форума — ${langs.join(', ')}${opts.version ? ` (${opts.version})` : ''}`,
      tree,
      parents: [parent],
    });
    if (c.status >= 300) ghError('Не удалось создать коммит', c);
    const up = await gh(token, 'PATCH', `/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: c.data.sha });
    if (up.status >= 300) ghError('Не удалось обновить ветку', up);
    commit = c.data.sha;
  }
  const head = commit ?? parent;

  // 6. Релизы: по одному на язык, тег <язык>-<версия>, во вложении zip папки языка
  // Ошибка одного языка (например, тег уже есть) не мешает остальным — итог по каждому языку в results.
  const releases: string[] = [];
  const results: LangResult[] = [];
  for (const lang of langs) {
    if (!opts.version) {
      results.push({ lang, status: 'committed' });
      continue;
    }
    const langFiles = exports.get(lang) ?? [];
    const tag = `${lang}-${opts.version}`;
    if (!langFiles.length) {
      results.push({ lang, status: 'skipped', tag });
      continue;
    }
    try {
      const [ls] = await db()<{ revision: number }[]>`select revision from language_status where game_id = ${game.id} and lang = ${lang}`;
      const revision = ls?.revision ?? 1;
      const credits = await db()<{ login: string; n: number }[]>`
        select u.login, count(*)::int as n from approved a join variants v on v.id = a.variant_id join users u on u.id = v.author_id
        join strings s on s.id = a.string_id where s.game_id = ${game.id} and a.lang = ${lang} and not s.removed
        group by u.login order by n desc, u.login`;
      const body = [
        `Перевод «${game.title}» (${lang}), версия ${opts.version}, ревизия ${revision}.`,
        '',
        `Распакуйте архив поверх файлов игры (структура папок как в оригинале).`,
        ...(credits.length ? ['', '**Переводчики:**', ...credits.map((c) => `- @${c.login} — ${c.n}`)] : []),
        '',
        `Форум: ${opts.site}#/g/${game.slug}/${lang}`,
      ].join('\n');
      const rel = await gh(token, 'POST', `/repos/${owner}/${name}/releases`, { tag_name: tag, target_commitish: head, name: `${game.title} — ${lang} ${opts.version}`, body });
      if (rel.status === 422) {
        results.push({ lang, status: 'exists', tag, error: `Релиз ${tag} уже существует — укажите другую версию` });
        continue;
      }
      if (rel.status >= 300) ghError('Не удалось создать релиз', rel);
      const zip = makeZip(langFiles.map((f) => ({ path: f.path, data: outBytes(f, encodeText) })));
      const asset = await gh(token, 'POST', `/repos/${owner}/${name}/releases/${rel.data.id}/assets?name=${encodeURIComponent(`${game.slug}-${tag}.zip`)}`, undefined, {
        contentType: 'application/zip',
        data: zip,
        base: 'https://uploads.github.com',
      });
      if (asset.status >= 300) ghError('Не удалось приложить архив к релизу', asset);
      releases.push(tag);
      results.push({ lang, status: 'released', tag });
    } catch (e) {
      results.push({ lang, status: 'error', tag, error: (e as Error).message });
    }
  }

  return { repo: game.repo, created, commit, files: files.length, releases, langs: results, url: `https://github.com/${game.repo}` };
}
