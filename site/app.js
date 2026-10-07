// LocalizationForum — клиент. Без сборки: обычный ES-модуль.
import { LOCALES, detectLocale, getLocale, setLocale, t } from './i18n.js';
import { ENCODINGS, decodeBytes, detectEncoding, looksBinary } from './encoding.js';

const API = (window.FORUM_API || '').replace(/\/$/, '') + '/api';
const view = document.getElementById('view');
const crumbs = document.getElementById('crumbs');
const account = document.getElementById('account');

// ---------- хранилище (может быть недоступно — тогда просто без входа) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

// После входа API возвращает нас на #token=… — забираем токен и восстанавливаем маршрут.
if (location.hash.startsWith('#token=')) {
  store.set('token', decodeURIComponent(location.hash.slice(7)));
  const back = store.get('returnRoute') || '#/';
  store.set('returnRoute', null);
  history.replaceState(null, '', location.pathname + location.search + back);
}

let me = null;

// ---------- утилиты ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (a, b) => (b ? Math.floor((a / b) * 100) : 0);
// Названия языков перевода игр (не языка интерфейса) — всегда самоназвания
// Частые языки перевода — для выбора в списке (порядок = порядок в списке)
const LANG_NAMES = {
  ru: 'Русский', en: 'English', uk: 'Українська', be: 'Беларуская', kk: 'Қазақша', de: 'Deutsch', fr: 'Français',
  es: 'Español', 'es-419': 'Español (Latinoamérica)', 'pt-BR': 'Português (Brasil)', 'pt-PT': 'Português (Portugal)',
  it: 'Italiano', pl: 'Polski', cs: 'Čeština', sk: 'Slovenčina', tr: 'Türkçe', nl: 'Nederlands', sv: 'Svenska', da: 'Dansk',
  no: 'Norsk', fi: 'Suomi', hu: 'Magyar', ro: 'Română', bg: 'Български', sr: 'Српски', hr: 'Hrvatski', el: 'Ελληνικά',
  lt: 'Lietuvių', lv: 'Latviešu', et: 'Eesti', ka: 'ქართული', hy: 'Հայերեն', az: 'Azərbaycan', uz: 'Oʻzbek',
  'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', ja: '日本語', ko: '한국어', vi: 'Tiếng Việt', th: 'ไทย', id: 'Bahasa Indonesia',
  ar: 'العربية', he: 'עברית', fa: 'فارسی', hi: 'हिन्दी',
};
// Остальные коды — самоназванием из браузера (Intl.DisplayNames), иначе сам код
const langName = (l) => {
  if (LANG_NAMES[l]) return LANG_NAMES[l];
  try {
    const n = new Intl.DisplayNames([l], { type: 'language' }).of(l);
    return n && n !== l ? n.charAt(0).toLocaleUpperCase(l) + n.slice(1) : l;
  } catch {
    return l;
  }
};
const LANG_CODE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
/** Обложка: своя картинка или шапка из Steam (домен akamai — cloudflare-CDN Steam недоступен в части стран) */
const coverOf = (g) => {
  if (g.cover_url) return g.cover_url;
  const steam = (g.links || []).find((l) => l.kind === 'steam');
  const m = steam?.url.match(/store\.steampowered\.com\/app\/(\d+)/);
  return m ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${m[1]}/header.jpg` : null;
};
const coverImg = (g, cls = 'cover') => {
  const src = coverOf(g);
  return src ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
};
const SITE = 'LocalizationForum';
const docTitle = (...parts) => (document.title = [...parts.filter(Boolean), SITE].join(' · '));

// ---------- уведомления и отмена последнего действия ----------
const undoStack = []; // { label, run }

function toast(msg, undo) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button class="toast-undo" data-act="undo">${t('toast.undo')} <kbd>Ctrl+Z</kbd></button>` : ''}`;
  if (undo) {
    undoStack.push(undo);
    if (undoStack.length > 30) undoStack.shift();
  }
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), undo ? 6000 : 2800);
}

async function undoLast() {
  const u = undoStack.pop();
  if (!u) return toast(t('undo.nothing'));
  try {
    await u.run();
    toast(t('undo.done', { label: u.label }));
  } catch (err) {
    toast(t('undo.failed', { error: err.message }));
  }
}

/** Перерисовать строку по id, если она на экране. */
async function refreshById(id) {
  const card = document.querySelector(`[data-string="${id}"]`);
  if (card) await refreshCard(card);
}

// ---------- резервная копия только для чтения (снимок на GitHub Pages) ----------
// Пока API отвечает, снимок не трогаем вовсе. Если чтение (GET) не удалось — сеть, тайм-аут 8 с, 5xx, 402/429 —
// переключаемся на снимок до перезагрузки страницы: баннер, все действия записи выключены.
const PAGES_DATA = 'https://mitay-walle.github.io/LocalizationForum/data/';
const SNAPSHOT_BASE = window.FORUM_SNAPSHOT || (location.hostname.endsWith('github.io') ? new URL('data/', location.href.split('#')[0]).href : PAGES_DATA);
const snapshot = { on: false, meta: null, files: new Map(), strings: new Map() };
const READ_TIMEOUT_MS = 8000;
const failoverStatus = (st) => st >= 500 || st === 402 || st === 429;

async function snapFile(rel) {
  if (!snapshot.files.has(rel)) {
    snapshot.files.set(rel, fetch(SNAPSHOT_BASE + rel).then((r) => {
      if (!r.ok) throw Object.assign(new Error(t('snap.unavailable')), { status: 404 });
      return r.json();
    }));
    snapshot.files.get(rel).catch(() => snapshot.files.delete(rel)); // ошибку не кэшируем
  }
  return snapshot.files.get(rel);
}

async function enterSnapshot() {
  if (snapshot.on) return;
  snapshot.on = true;
  me = null; // в копии нет входа и записи
  snapshot.meta = await snapFile('meta.json').catch(() => null);
  renderAccount();
}

function renderSnapshotBanner() {
  let el = document.getElementById('snapshot-banner');
  if (!snapshot.on) return el?.remove();
  if (!el) {
    el = Object.assign(document.createElement('div'), { id: 'snapshot-banner', className: 'snapshot-banner' });
    el.setAttribute('role', 'status');
    document.querySelector('header.top').after(el);
  }
  const date = snapshot.meta?.generatedAt ? new Date(snapshot.meta.generatedAt).toLocaleString(getLocale()) : '?';
  el.innerHTML = `<span>${t('snap.banner', { date: esc(date) })}</span><button type="button" class="btn small" data-act="snap-retry">${t('snap.retry')}</button>`;
}

/** Ответ API из снимка: те же формы данных; фильтры, поиск и страницы строк — локально. */
async function snapshotGet(path) {
  const [p, qs] = path.split('?');
  const q = new URLSearchParams(qs || '');
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent);
  const seg = encodeURIComponent;
  if (p === '/me') return { user: null };
  if (p === '/games') return snapFile('games.json');
  if (p === '/formats') return snapFile('formats.json');
  if (parts[0] === 'games' && parts.length === 2) return snapFile(`games/${seg(parts[1])}.json`);
  if (parts[0] === 'games' && parts.length === 3) {
    const [, slug, what] = parts;
    const lang = q.get('lang') || '';
    if (what === 'files' || what === 'credits') return snapFile(`games/${seg(slug)}/${what}/${seg(lang)}.json`);
    if (what === 'strings') return snapshotStrings(slug, lang, q);
  }
  throw Object.assign(new Error(t('snap.readOnly')), { status: 0 });
}

async function snapshotStrings(slug, lang, q) {
  const key = `${slug}\n${lang}`;
  if (!snapshot.strings.has(key)) {
    snapshot.strings.set(key, (async () => {
      const dir = `games/${encodeURIComponent(slug)}/strings/${encodeURIComponent(lang)}/`;
      const first = await snapFile(dir + '1.json');
      const pages = Math.max(1, Math.ceil(first.total / first.pageSize));
      const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => snapFile(`${dir}${i + 2}.json`)));
      return { first, all: [first, ...rest].flatMap((d) => d.strings) };
    })());
  }
  const { first, all } = await snapshot.strings.get(key);
  const filter = q.get('filter') || 'all';
  const file = q.get('file') || '';
  const needle = (q.get('q') || '').trim().toLowerCase();
  const keep = {
    all: () => true,
    untranslated: (s) => s.approved_text == null,
    voting: (s) => s.approved_text == null && s.variants.length > 0,
    approved: (s) => s.approved_text != null && !s.stale,
    stale: (s) => s.approved_text != null && !!s.stale,
  }[filter] || (() => true);
  const found = all.filter(
    (s) => keep(s) && (!file || s.file === file) &&
      (!needle || [s.key, s.source, s.approved_text].some((x) => x && String(x).toLowerCase().includes(needle))),
  );
  const pageSize = first.pageSize;
  const page = Math.max(1, Number(q.get('page')) || 1);
  return { ...first, page, total: found.length, canModerate: false, strings: found.slice((page - 1) * pageSize, page * pageSize) };
}

async function api(path, { method = 'GET', body } = {}) {
  if (method === 'GET' && snapshot.on) return snapshotGet(path);
  if (method !== 'GET' && snapshot.on) throw Object.assign(new Error(t('snap.readOnly')), { status: 0 });
  // Accept-Language — на будущее: сервер пока отвечает по-русски
  const headers = { 'Accept-Language': getLocale() };
  const token = store.get('token');
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: method === 'GET' ? AbortSignal.timeout(READ_TIMEOUT_MS) : undefined,
    });
  } catch {
    if (method === 'GET') {
      await enterSnapshot();
      return snapshotGet(path);
    }
    throw Object.assign(new Error(t('app.offline')), { status: 0 });
  }
  if (method === 'GET' && failoverStatus(res.status)) {
    await enterSnapshot();
    return snapshotGet(path);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { store.set('token', null); me = null; renderAccount(); }
  if (!res.ok) throw Object.assign(new Error(data.error || t('app.error', { status: res.status })), { status: res.status, data });
  return data;
}

function login() {
  if (snapshot.on) return toast(t('snap.readOnly'));
  store.set('returnRoute', location.hash || '#/');
  const ret = location.origin + location.pathname;
  location.href = `${API}/auth/login?return=${encodeURIComponent(ret)}`;
}

function logout() {
  store.set('token', null);
  me = null;
  renderAccount();
  route();
}

async function loadMe() {
  if (!store.get('token')) { me = null; return; }
  try { me = (await api('/me')).user; } catch { me = null; }
}

const localeOptions = () => LOCALES.map(([c, n]) => `<option value="${c}" ${c === getLocale() ? 'selected' : ''}>${esc(n)}</option>`).join('');

function renderAccount() {
  renderSnapshotBanner();
  account.innerHTML = `
    ${me
      ? `${me.avatar_url ? `<img class="avatar" src="${esc(me.avatar_url)}&s=52" alt="">` : ''}<span>${esc(me.login)}</span>`
      : snapshot.on ? '' : `<button class="btn small primary" data-act="login">${t('account.login')}</button>`}
    <select class="ui-lang" data-ui="lang" title="${esc(t('ui.language'))}" aria-label="${esc(t('ui.language'))}">${localeOptions()}</select>
    <button class="icon-btn" data-act="ui-menu" title="${esc(t('ui.settings'))}" aria-label="${esc(t('ui.settings'))}">⚙</button>
    <div class="ui-menu" hidden>
      <h3>${t('ui.language')}</h3>
      <select data-ui="lang" aria-label="${esc(t('ui.language'))}">${localeOptions()}</select>
      <h3>${t('ui.theme')}</h3>
      <div class="seg" data-ui="theme">
        <button data-v="auto">${t('ui.theme.auto')}</button><button data-v="light">${t('ui.theme.light')}</button><button data-v="dark">${t('ui.theme.dark')}</button>
      </div>
      <h3>${t('ui.textSize')}</h3>
      <div class="range-row"><span class="muted">A</span><input type="range" min="13" max="21" step="1" data-ui="size"><span style="font-size:1.3rem">A</span><b data-ui="size-val"></b></div>
      <h3>${t('ui.undo')}</h3>
      <p class="muted" style="margin:0;font-size:.87rem">${t('ui.undoHelp')}</p>
      ${me ? `<a href="#/tokens">${t('ui.tokens')}</a><button class="btn small" data-act="logout">${t('account.logout')}</button>` : ''}
    </div>`;
  syncUiMenu();
}

// ---------- настройки интерфейса (хранятся в браузере) ----------
const uiPrefs = (() => {
  try {
    return JSON.parse(localStorage.getItem('ui') || '{}');
  } catch {
    return {};
  }
})();
function applyUi() {
  const root = document.documentElement;
  if (uiPrefs.theme === 'light' || uiPrefs.theme === 'dark') root.dataset.theme = uiPrefs.theme;
  else delete root.dataset.theme;
  root.style.setProperty('--base-size', (uiPrefs.size || 15) + 'px');
  store.set('ui', JSON.stringify(uiPrefs));
  syncUiMenu();
}
function syncUiMenu() {
  const menu = account.querySelector('.ui-menu');
  if (!menu) return;
  menu.querySelectorAll('[data-ui=theme] button').forEach((b) => b.classList.toggle('on', b.dataset.v === (uiPrefs.theme || 'auto')));
  menu.querySelector('[data-ui=size]').value = uiPrefs.size || 15;
  menu.querySelector('[data-ui=size-val]').textContent = (uiPrefs.size || 15) + ' px';
}
document.addEventListener('click', (e) => {
  const menu = account.querySelector('.ui-menu');
  if (!menu) return;
  if (e.target.closest('[data-act=ui-menu]')) menu.hidden = !menu.hidden;
  else if (!e.target.closest('.ui-menu')) menu.hidden = true;
  const tb = e.target.closest('[data-ui=theme] button');
  if (tb) {
    uiPrefs.theme = tb.dataset.v === 'auto' ? undefined : tb.dataset.v;
    applyUi();
  }
});
document.addEventListener('input', (e) => {
  if (!e.target.matches?.('[data-ui=size]')) return;
  uiPrefs.size = Number(e.target.value);
  applyUi();
});

// Смена языка интерфейса: без перезагрузки перерисовываем шапку и текущую страницу
async function switchLocale(code) {
  const menuOpen = account.querySelector('.ui-menu')?.hidden === false;
  uiPrefs.locale = await setLocale(code);
  applyUi();
  renderAccount();
  if (menuOpen) account.querySelector('.ui-menu').hidden = false;
  await route();
}
document.addEventListener('change', (e) => {
  if (e.target.matches?.('select[data-ui=lang]')) switchLocale(e.target.value);
});

// ---------- маршруты ----------
function parseRoute() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), q: new URLSearchParams(qs || '') };
}

function href(slug, lang, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null && v !== 'all' && v !== 1));
  return `#/g/${encodeURIComponent(slug)}/${encodeURIComponent(lang)}${q.toString() ? '?' + q : ''}`;
}

async function route() {
  const { parts, q } = parseRoute();
  try {
    if (parts[0] === 'new') await renderNewGame();
    else if (parts[0] === 'formats') await renderFormats(parts[1], q);
    else if (parts[0] === 'tokens') await renderTokens();
    else if (parts[0] === 'g' && parts[1] && parts[2] === 'settings') await renderSettings(parts[1], q);
    else if (parts[0] === 'g' && parts[1] && !parts[2]) await renderOverview(parts[1]);
    else if (parts[0] === 'g' && parts[1]) await renderGame(parts[1], parts[2], q);
    else await renderHome();
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

const gamesCrumb = () => `<a href="#/">${t('nav.games')}</a>`;

// ---------- главная ----------
async function renderHome() {
  crumbs.innerHTML = '';
  docTitle();
  const { games } = await api('/games');
  const head = `<div class="page-head"><h1>${t('home.title')}</h1><span class="spacer"></span><a class="btn" href="#/formats">${t('home.formats')}</a>${me ? `<a class="btn primary" href="#/new">${t('home.newGame')}</a>` : snapshot.on ? '' : `<button class="btn" data-act="login">${t('home.loginToAdd')}</button>`}</div>`;
  if (!games.length) {
    view.innerHTML = head + `<div class="empty">${t('home.empty')}${me ? ' ' + t('home.emptyAdd') : ''}</div>`;
    return;
  }
  view.innerHTML = head + `<div class="games">${games
    .map(
      (g) => `
      <section class="card game-card">
        ${coverImg(g)}
        <h2><a class="card-link" href="#/g/${encodeURIComponent(g.slug)}">${esc(g.title)}</a></h2>
        ${g.description ? `<p class="card-desc">${esc(g.description)}</p>` : ''}
        <div class="muted">${t('home.strings', { n: g.total })}${usedFormats(g) ? ` · ${esc(usedFormats(g))}` : ''}${g.repo ? ` · <a href="https://github.com/${esc(g.repo)}" target="_blank" rel="noopener">${esc(g.repo)}</a>` : ''}</div>
        <div class="langs">${g.languages
          .map((l) => {
            const p = pct(g.approved[l] || 0, g.total);
            return `<a class="lang-row" href="${href(g.slug, l)}"><b>${esc(l)}</b><span class="bar"><i style="width:${p}%"></i></span><span class="pct">${p}%</span>${stageChip(g.status?.[l])}</a>`;
          })
          .join('')}</div>
        ${g.repo ? `<div style="margin-top:10px"><a href="https://github.com/${esc(g.repo)}/releases" target="_blank" rel="noopener">${t('home.releases')}</a></div>` : ''}
      </section>`,
    )
    .join('')}</div>`;
}

// ---------- этапы перевода языка ----------
const STAGES = ['open', 'review', 'done'];
/** [id, название, описание] на текущем языке интерфейса */
const stageInfo = (id) => {
  const k = STAGES.includes(id) ? id : STAGES[0];
  return [k, t(`stage.${k}`), t(`stage.${k}.desc`)];
};
const stageChip = (id) => { const [k, title, d] = stageInfo(id); return `<span class="stage ${k}" title="${esc(d)}">${esc(title)}</span>`; };

// ---------- страница перевода ----------
const FILTERS = ['all', 'untranslated', 'voting', 'approved', 'stale'];

let state = null; // { slug, lang, game, data, params }

async function renderGame(slug, lang, q) {
  const { game, stats, canManage, status, moderates, ban } = await api(`/games/${encodeURIComponent(slug)}`);
  if (!lang || !game.languages.includes(lang)) {
    location.replace(`#/g/${encodeURIComponent(slug)}`);
    return;
  }
  const params = { file: q.get('file') || '', filter: q.get('filter') || 'all', q: q.get('q') || '', page: Number(q.get('page') || 1) };
  const qs = new URLSearchParams({ lang, filter: params.filter, page: String(params.page) });
  if (params.file) qs.set('file', params.file);
  if (params.q) qs.set('q', params.q);
  const [files, data] = await Promise.all([
    api(`/games/${encodeURIComponent(slug)}/files?lang=${encodeURIComponent(lang)}`),
    api(`/games/${encodeURIComponent(slug)}/strings?${qs}`),
  ]);
  const stage = status?.[lang]?.status || 'open';
  const canMod = !!moderates?.[lang];
  // Что можно делать на этом этапе (сервер проверяет то же самое)
  const can = { propose: stage === 'open' || (stage === 'review' && canMod), vote: stage === 'open' || (stage === 'review' && canMod), approve: stage !== 'done' && canMod };
  // Забаненный (в игре или на всём форуме) только читает — сервер проверяет то же самое
  if (ban || snapshot.on) can.propose = can.vote = can.approve = false; // бан или копия только для чтения
  state = { slug, lang, game, data, params, files: files.files, stage, can, ban, canManage };
  const st = stats.find((s) => s.lang === lang) || { approved: 0, stale: 0, voting: 0, total: 0 };
  state.st = st;

  docTitle(`${game.title} — ${langName(lang)}`);
  crumbs.innerHTML = `${gamesCrumb()} / <a href="#/g/${encodeURIComponent(slug)}">${esc(game.title)}</a> / ${esc(langName(lang))}`;

  const settingsHref = `#/g/${encodeURIComponent(slug)}/settings`;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  view.innerHTML = `
    <div class="layout">
      <aside class="side">${renderSide(files.files, st)}</aside>
      <section>
        <div class="stats">
          <span>${t('game.translated')} <b>${pct(st.approved, st.total)}%</b></span>
          <span>${t('game.approved')} <b>${st.approved}</b></span>
          <span>${t('game.voting')} <b>${st.voting}</b></span>
          <span>${t('game.stale')} <b>${st.stale}</b></span>
          <span>${t('game.total')} <b>${st.total}</b></span>
          ${game.languages.length > 1 ? `<span>${t('game.language')} <select data-act="lang">${game.languages.map((l) => `<option value="${esc(l)}" ${l === lang ? 'selected' : ''}>${esc(langName(l))}</option>`).join('')}</select></span>` : ''}
          <span class="spacer"></span>
          ${!st.approved ? '' : !snapshot.on ? `<button class="btn small" data-act="download" data-slug="${esc(slug)}" data-lang="${esc(lang)}">${t('game.download')}</button>`
            : game.repo ? `<a class="btn small" href="https://github.com/${esc(game.repo)}/releases?q=${encodeURIComponent(lang + '-')}&expanded=true" target="_blank" rel="noopener">${t('game.download')}</a>` : ''}
          ${canManage ? `<a class="btn small" href="${settingsHref}">${t('game.settings')}</a>` : ''}
        </div>
        ${renderStageBanner(status?.[lang], canMod)}
        ${ban ? renderBanBanner(ban) : ''}
        ${!st.total ? `<div class="empty">${t('game.noStrings')}${canManage ? ' ' + t('game.noStringsUpload', { href: settingsHref }) : ''}</div>` : ''}
        <div class="toolbar">
          <nav class="tabs">${FILTERS.map((id) => `<a href="${href(slug, lang, { ...params, filter: id, page: 1 })}" class="${params.filter === id ? 'on' : ''}">${t('filter.' + id)}</a>`).join('')}</nav>
          <input class="search" type="search" placeholder="${esc(t('game.search'))}" value="${esc(params.q)}" data-act="search">
        </div>
        ${data.strings.length ? data.strings.map(renderString).join('') : `<div class="empty">${t('game.nothing')}</div>`}
        ${pages > 1 ? `<div class="pager">
          ${params.page > 1 ? `<a class="btn" href="${href(slug, lang, { ...params, page: params.page - 1 })}">${t('game.prev')}</a>` : ''}
          <span class="muted">${params.page} / ${pages}</span>
          ${params.page < pages ? `<a class="btn" href="${href(slug, lang, { ...params, page: params.page + 1 })}">${t('game.next')}</a>` : ''}
        </div>` : ''}
      </section>
    </div>`;
}

function renderStageBanner(info, canMod) {
  const cur = info?.status || 'open';
  const [, , desc] = stageInfo(cur);
  const when = info?.updated_at ? ` · ${esc(info.by || '')} ${new Date(info.updated_at).toLocaleDateString(getLocale())}` : '';
  const ctl = canMod
    ? `<span class="spacer"></span><div class="seg" role="group" aria-label="${esc(t('stage.aria'))}">${STAGES.map((k) => `<button type="button" data-act="stage" data-v="${k}" class="${k === cur ? 'on' : ''}">${esc(stageInfo(k)[1])}</button>`).join('')}</div>`
    : '';
  const rev = `<span class="rev-label" title="${esc(t('rev.help'))}">${t('rev.label', { n: info?.revision ?? 1 })}</span>`;
  const revBtn = canMod && !snapshot.on ? revisionButton(state.slug, state.lang, (state.st?.approved ?? 0) + (state.st?.stale ?? 0), cur) : '';
  return `<div data-rev-host><div class="stage-banner ${cur}">${stageChip(cur)}${rev}<span class="muted">${esc(desc)}${when}</span>${ctl}${revBtn}</div><div class="rev-box" hidden></div></div>`;
}

// ---------- ревизии: «Новая ревизия» снимает все утверждения языка (тексты остаются вариантами) ----------

const revisionButton = (slug, lang, count, stage) =>
  `<button type="button" class="btn small" data-rev-open data-slug="${esc(slug)}" data-lang="${esc(lang)}" data-count="${count}" data-stage="${esc(stage)}">${t('rev.new')}</button>`;

document.addEventListener('click', async (e) => {
  const open = e.target.closest('[data-rev-open]');
  if (open) {
    const { slug, lang, count, stage } = open.dataset;
    const box = open.closest('[data-rev-host]').querySelector('.rev-box');
    box.hidden = false;
    // Подтверждение прямо на странице: сколько утверждений снимется и с какого этапа начать
    box.innerHTML = `<div class="rev-confirm" data-slug="${esc(slug)}" data-lang="${esc(lang)}" data-stage="${esc(stage)}">
      <p>${t('rev.confirm', { n: count })}</p>
      ${stage === 'done' ? `<p class="muted">${t('rev.doneStage')}</p>` : ''}
      <label>${t('rev.stage')} <select data-rev-stage>
        ${stage === 'done' ? '' : `<option value="">${t('rev.keepStage', { stage: esc(stageInfo(stage)[1]) })}</option>`}
        <option value="review" selected>${esc(stageInfo('review')[1])}</option>
        <option value="open">${esc(stageInfo('open')[1])}</option>
      </select></label>
      <div class="actions"><button type="button" class="btn small bad" data-rev-go>${t('rev.go')}</button><button type="button" class="btn small" data-rev-cancel>${t('common.cancel')}</button></div>
    </div>`;
    return;
  }
  if (e.target.closest('[data-rev-cancel]')) {
    const box = e.target.closest('.rev-box');
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const go = e.target.closest('[data-rev-go]');
  if (!go) return;
  const c = go.closest('.rev-confirm');
  const { slug, lang } = c.dataset;
  const path = `/games/${encodeURIComponent(slug)}/revision`;
  try {
    go.disabled = true;
    const r = await api(path, { method: 'POST', body: { lang, stage: c.querySelector('[data-rev-stage]').value || undefined } });
    toast(t('rev.done', { n: r.revision, archived: r.archived }), {
      label: t('rev.undo'),
      run: async () => {
        await api(`${path}/undo`, { method: 'POST', body: { lang, stage: r.previousStage } });
        await route();
      },
    });
    await route();
  } catch (err) {
    go.disabled = false;
    toast(err.message);
  }
});

/** Плашка «вы заблокированы»: причина и срок. */
function renderBanBanner(ban) {
  const until = ban.until ? t('ban.until', { date: esc(new Date(ban.until).toLocaleString(getLocale())) }) : t('ban.forever');
  return `<div class="stage-banner ban" role="alert"><b>${t(ban.game ? 'ban.game' : 'ban.global')}</b><span>${ban.reason ? t('ban.reason', { reason: esc(ban.reason) }) + ' · ' : ''}${until}</span><span class="muted">${t('ban.readOnly')}</span></div>`;
}

/** Достигнут ли лимит вариантов у строки для текущего пользователя (модераторы языка не ограничены). */
function variantLimitHint(s) {
  const L = state.data.limits;
  if (!me || !L || state.data.canModerate) return '';
  const mine = s.variants.filter((v) => v.author === me.login).length;
  if (L.perUserString && mine >= L.perUserString) return t('limit.perUser', { n: L.perUserString });
  if (L.perString && s.variants.length >= L.perString) return t('limit.perString', { n: L.perString });
  return '';
}

const aiBadge = () => ` <span class="ai" title="${esc(t('str.aiTitle'))}">${t('str.ai')}</span>`;

function renderString(s) {
  const mod = state.data.canModerate && state.can.approve;
  const { propose: canPropose, vote: canVote } = state.can;
  const limitHint = canPropose ? variantLimitHint(s) : '';
  const voteTitle = (v) => (state.ban ? t('str.banned') : canVote ? (v.mine ? t('str.unvote') : t('str.vote')) : t('str.voteClosed'));
  // Управляющий игрой может забанить автора варианта (форма бана в настройках игры)
  const banLink = (author) =>
    state.canManage && me && author && author !== me.login
      ? ` · <a class="link" href="#/g/${encodeURIComponent(state.slug)}/settings?ban=${encodeURIComponent(author)}" title="${esc(t('str.banTitle', { name: author }))}">${t('str.ban')}</a>`
      : '';
  // Утверждённый вариант уже показан блоком «утверждено» — в списке его не дублируем
  const chosenVariant = s.stale ? null : s.variants.find((v) => v.id === s.approved_variant);
  const approved = s.approved_text != null
    ? `<div class="approved ${s.stale ? 'stale' : ''}">${s.stale ? `<span class="badge">${t('str.sourceChanged')}</span>` : ''}<div class="atext">${esc(s.approved_text)}</div><span class="meta">${t('str.approved')}${s.approved_by ? ` · ${esc(s.approved_by)}` : ''}${chosenVariant ? ` · ${t('str.author', { name: esc(chosenVariant.author || t('str.anon')) })}${chosenVariant.ai ? aiBadge() : ''}${chosenVariant.votes ? ` · ▲ ${chosenVariant.votes}` : ''}` : ''}</span>${mod ? `<button class="btn small unapprove" data-act="unapprove" data-id="${s.id}">${t('str.unapprove')}</button>` : ''}</div>`
    : '';
  const variants = s.variants
    .filter((v) => v !== chosenVariant)
    .map((v) => {
      const canDelete = me && state.stage !== 'done' && ((v.author === me.login && canPropose) || mod);
      return `<li class="variant">
        <button class="vote ${v.mine ? 'mine' : ''}" data-act="vote" data-id="${v.id}" data-mine="${v.mine ? 1 : 0}" title="${esc(voteTitle(v))}" ${canVote ? '' : 'disabled'}>▲<span>${v.votes}</span></button>
        <div><div class="vtext">${esc(v.text)}</div><div class="vmeta">${esc(v.author || t('str.anon'))}${v.ai ? aiBadge() : ''}${v.was_approved_rev ? ` <span class="prev-rev">${t('rev.wasApproved', { n: v.was_approved_rev })}</span>` : ''}${banLink(v.author)}</div></div>
        <div class="vactions">
          ${mod ? `<button class="btn small" data-act="approve" data-id="${s.id}" data-variant="${v.id}">${t('str.approve')}</button>` : ''}
          ${canDelete ? `<button class="link" data-act="delete" data-id="${v.id}" title="${esc(t('str.deleteTitle'))}">${t('str.delete')}</button>` : ''}
        </div>
      </li>`;
    })
    .join('');
  return `<article class="str" data-string="${s.id}">
    <div class="str-src">
      <div class="str-head"><span class="mono" title="${esc(s.file)}">${esc(s.key)}</span>${s.context ? `<span class="context">${esc(s.context)}</span>` : ''}</div>
      <div class="source">${esc(s.source)}</div>
    </div>
    <div class="str-tr">
    ${approved}
    ${variants ? `<ul class="variants">${variants}</ul>` : ''}
    ${limitHint && !mod ? `<p class="muted limit-hint">${limitHint}</p>` : canPropose || mod ? `<div class="propose">
      <textarea rows="1" placeholder="${esc(me ? t('str.placeholder') : t('str.loginToPropose'))}" data-act="draft" data-id="${s.id}" ${me ? '' : 'disabled'}></textarea>
      <div class="propose-row" hidden>
        ${canPropose ? `<button class="btn primary small" data-act="propose" data-id="${s.id}">${t('str.propose')}</button>` : ''}
        ${mod ? `<button class="btn small" data-act="approve-text" data-id="${s.id}">${t('str.approveText')}</button>` : ''}
        <button class="link" data-act="copy-source" data-id="${s.id}">${t('str.copySource')}</button>
      </div>
      <ul class="issues"></ul>
    </div>` : ''}
  </div>
  </article>`;
}

function showIssues(card, issues) {
  const box = card.querySelector('.issues');
  if (box) box.innerHTML = (issues || []).map((i) => `<li class="${i.level}">${esc(i.message)}</li>`).join('');
}

/** Обновить кнопку голоса на месте. */
function setVoteButton(btn, mine, votes) {
  btn.classList.toggle('mine', mine);
  btn.dataset.mine = mine ? '1' : '0';
  btn.title = mine ? t('str.unvote') : t('str.vote');
  btn.querySelector('span').textContent = votes;
}

// ---------- действия ----------
const lang = () => state?.lang;

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'login') return login();
  if (act === 'logout') return logout();
  if (act === 'undo') return undoLast();
  if (act === 'snap-retry') return location.reload();
  if (['vote', 'propose', 'approve', 'approve-text', 'unapprove', 'delete', 'copy-source'].includes(act) && !me) return login();
  const card = el.closest('[data-string]');
  try {
    const sid = card ? Number(card.dataset.string) : null;
    const prev = sid ? { ...state.data.strings.find((x) => x.id === sid) } : null;
    const L = lang();
    // Вернуть утверждение строки к состоянию prev
    const restoreApproval = async () => {
      if (prev.approved_text == null) await api(`/strings/${sid}/approve?lang=${encodeURIComponent(L)}`, { method: 'DELETE' });
      else if (prev.approved_variant && prev.variants.some((v) => v.id === prev.approved_variant))
        await api(`/strings/${sid}/approve`, { method: 'POST', body: { lang: L, variantId: prev.approved_variant } });
      else await api(`/strings/${sid}/approve`, { method: 'POST', body: { lang: L, text: prev.approved_text } });
      await refreshById(sid);
    };
    if (act === 'vote') {
      const mine = el.dataset.mine === '1';
      const vid = el.dataset.id;
      const r = await api(`/variants/${vid}/vote`, { method: mine ? 'DELETE' : 'POST' });
      // Голос за строку один: сервер снял голос с других вариантов (cleared)
      const cleared = r.cleared || [];
      setVoteButton(el, r.mine, r.votes);
      for (const cid of cleared) {
        const b = card.querySelector(`[data-act="vote"][data-id="${cid}"]`);
        if (b) setVoteButton(b, false, Math.max(0, Number(b.querySelector('span').textContent) - 1));
      }
      // Снятый голос мог быть у утверждённого варианта (он показан отдельным блоком) — проще перерисовать строку
      if (cleared.length) await refreshCard(card);
      toast(r.mine ? t(cleared.length ? 'vote.moved' : 'vote.added') : t('vote.removed'), {
        label: r.mine ? t('undo.vote') : t('undo.unvote'),
        run: async () => {
          if (r.mine) {
            // Отмена голоса: снять новый и вернуть прежний, если был
            await api(`/variants/${vid}/vote`, { method: 'DELETE' });
            for (const cid of cleared) await api(`/variants/${cid}/vote`, { method: 'POST' });
          } else {
            await api(`/variants/${vid}/vote`, { method: 'POST' });
          }
          await refreshById(sid);
        },
      });
    } else if (act === 'propose') {
      const ta = card.querySelector('textarea');
      const text = ta.value;
      const r = await api(`/strings/${el.dataset.id}/variants`, { method: 'POST', body: { lang: L, text } });
      toast(r.issues?.length ? t('variant.addedIssues') : t('variant.added'), {
        label: t('undo.propose'),
        run: async () => {
          await api(`/variants/${r.id}`, { method: 'DELETE' });
          await refreshById(sid);
          const t2 = document.querySelector(`[data-string="${sid}"] textarea`);
          if (t2) {
            t2.value = text;
            t2.dispatchEvent(new Event('input', { bubbles: true }));
          }
        },
      });
      await refreshCard(card);
    } else if (act === 'approve' || act === 'approve-text') {
      const body = act === 'approve' ? { lang: L, variantId: Number(el.dataset.variant) } : { lang: L, text: card.querySelector('textarea').value };
      await api(`/strings/${el.dataset.id}/approve`, { method: 'POST', body });
      toast(t('approve.done'), { label: t('undo.approve'), run: restoreApproval });
      await refreshCard(card);
    } else if (act === 'unapprove') {
      await api(`/strings/${el.dataset.id}/approve?lang=${encodeURIComponent(L)}`, { method: 'DELETE' });
      toast(t('approve.removed'), { label: t('undo.unapprove'), run: restoreApproval });
      await refreshCard(card);
    } else if (act === 'delete') {
      const v = prev.variants.find((x) => x.id === Number(el.dataset.id));
      await api(`/variants/${el.dataset.id}`, { method: 'DELETE' });
      toast(t('variant.deleted'), {
        label: t('undo.delete'),
        run: async () => {
          await api(`/strings/${sid}/variants`, { method: 'POST', body: { lang: L, text: v.text } });
          await refreshById(sid);
        },
      });
      await refreshCard(card);
    } else if (act === 'copy-source') {
      const s = state.data.strings.find((x) => x.id === Number(el.dataset.id));
      const ta = card.querySelector('textarea');
      ta.value = s.source;
      ta.focus();
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } catch (err) {
    if (card && err.data?.issues) showIssues(card, err.data.issues);
    // Лимиты (422/429) и баны (403) — показываем и под полем ввода, не только во всплывашке
    else if (card && act === 'propose') showIssues(card, [{ level: 'error', message: err.message }]);
    toast(err.message);
  }
});

/** Перерисовать одну строку, не теряя прокрутку. */
async function refreshCard(card) {
  const id = Number(card.dataset.string);
  const s = state.data.strings.find((x) => x.id === id);
  const qs = new URLSearchParams({ lang: state.lang, q: s.key, file: s.file });
  const data = await api(`/games/${encodeURIComponent(state.slug)}/strings?${qs}`);
  const fresh = data.strings.find((x) => x.id === id);
  if (!fresh) return card.remove();
  Object.assign(s, fresh);
  card.outerHTML = renderString(fresh);
}

let checkTimer;
document.addEventListener('input', (e) => {
  const ta = e.target.closest('textarea[data-act="draft"]');
  if (!ta) return;
  const card = ta.closest('[data-string]');
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
  card.querySelector('.propose-row').hidden = !ta.value.trim();
  clearTimeout(checkTimer);
  if (!ta.value.trim()) return showIssues(card, []);
  checkTimer = setTimeout(async () => {
    try {
      const r = await api(`/strings/${ta.dataset.id}/variants`, { method: 'POST', body: { lang: lang(), text: ta.value, check: true } });
      showIssues(card, r.issues);
    } catch {}
  }, 400);
});

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (!typing && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undoLast();
    return;
  }
  if (e.target.matches?.('textarea[data-act="draft"]') && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    e.target.closest('[data-string]').querySelector('[data-act="propose"]').click();
  }
});

// Смена этапа перевода (только модераторы языка)
async function setStage(next) {
  await api(`/games/${encodeURIComponent(state.slug)}/status`, { method: 'POST', body: { lang: state.lang, status: next } });
  await route();
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act=stage]');
  if (!b || !state || b.classList.contains('on')) return;
  const prev = state.stage;
  const next = b.dataset.v;
  try {
    await setStage(next);
    toast(t('stage.changed', { stage: stageInfo(next)[1] }), { label: t('undo.stage'), run: () => setStage(prev) });
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.matches('select[data-act="lang"]')) location.hash = href(state.slug, e.target.value, { ...state.params, page: 1 }).slice(1);
});

let searchTimer;
document.addEventListener('input', (e) => {
  if (!e.target.matches('input[data-act="search"]')) return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    location.hash = href(state.slug, state.lang, { ...state.params, q: e.target.value.trim(), page: 1 }).slice(1);
  }, 400);
});

window.addEventListener('hashchange', () => {
  const focusSearch = document.activeElement?.matches?.('input[data-act="search"]');
  route().then(() => {
    if (focusSearch) {
      const s = document.querySelector('input[data-act="search"]');
      s?.focus();
      s?.setSelectionRange(s.value.length, s.value.length);
    }
  });
});

// Язык интерфейса: сохранённый выбор → язык браузера → английский
uiPrefs.locale = await setLocale(detectLocale(uiPrefs.locale));
await loadMe();
renderAccount();
route();

// ======================================================================
// Управление играми: создание, настройки, загрузка файлов, модераторы
// ======================================================================

const FORMAT_HINT_KEYS = ['rimworld', 'json', 'json-nested', 'gunpoint'];

let formatsCache = null;
async function loadFormats(force = false) {
  if (!formatsCache || force) formatsCache = (await api('/formats')).formats;
  return formatsCache;
}
const fmtInfo = (list, slug) => {
  const f = list.find((x) => x.slug === slug) || { slug, title: slug, extensions: [], kind: 'custom' };
  return { ...f, name: f.title, ext: f.extensions, hint: FORMAT_HINT_KEYS.includes(slug) ? t('fmt.hint.' + slug) : t('fmt.hint.default', { ext: f.extensions.join(', ') }) };
};
const KINDS = ['builtin', 'preset', 'custom'];
const kindTitle = (kind) => t('fmt.kind.' + kind);
function formatOptions(list, selected) {
  return KINDS.map((kind) => {
    const items = list.filter((f) => f.kind === kind);
    if (!items.length) return '';
    return `<optgroup label="${esc(kindTitle(kind))}">${items
      .map((f) => `<option value="${esc(f.slug)}" ${f.slug === selected ? 'selected' : ''}>${esc(f.title)} (${esc(f.extensions.join(', '))})</option>`)
      .join('')}</optgroup>`;
  }).join('');
}

// ---------- форматы по расширениям файлов ----------

/** «-» в карте форматов игры — файл не переводится, копируется в перевод как есть. */
const RAW = '-';
/** Расширение файла в нижнем регистре с точкой (как extOf на сервере): «Scripts/A.GPC» → «.gpc», без расширения — ''. */
const extOf = (path) => {
  const base = path.split('/').pop() || '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
};
const formatTitle = (list, slug) => (slug === RAW ? t('fmap.raw') : list.find((f) => f.slug === slug)?.title || slug);
/** Форматы игры для карточки на главной: разные форматы из карты (без «как есть»), иначе формат по умолчанию. */
const usedFormats = (g) => [...new Set(Object.values(g.format_map || {}).filter((v) => v !== RAW))].join(', ') || g.format || '';
/** Формат для файла по карте игры: расширение → «*». undefined — расширения в карте нет. */
const mappedFormat = (map, path) => map?.[extOf(path)] ?? map?.['*'];
/** Какие форматы объявили расширение (кандидаты при автоподборе на сервере). */
const formatsForExt = (list, ext) => list.filter((f) => f.extensions.some((e) => e.toLowerCase() === ext));
/** Варианты для строки таблицы форматов: «по умолчанию» (для «*» — «не задан»), «как есть», затем все форматы. */
function mapOptions(list, selected, emptyLabel) {
  return `${emptyLabel ? `<option value="" ${selected ? '' : 'selected'}>${esc(emptyLabel)}</option>` : ''}
    <option value="${RAW}" ${selected === RAW ? 'selected' : ''}>${esc(t('fmap.raw'))}</option>
    ${formatOptions(list, selected)}`;
}

const slugify = (s) =>
  s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

const parseLangs = (v) => v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

async function renderNewGame() {
  crumbs.innerHTML = `${gamesCrumb()} / ${t('new.title')}`;
  docTitle(t('new.title'));
  if (snapshot.on) {
    view.innerHTML = `<div class="empty">${t('snap.readOnly')}</div>`;
    return;
  }
  if (!me) {
    view.innerHTML = `<div class="empty">${t('new.loginPrompt', { button: `<button class="btn primary" data-act="login">${t('new.loginButton')}</button>` })}</div>`;
    return;
  }
  view.innerHTML = `
    <form class="panel form" data-form="new-game">
      <h1>${t('new.title')}</h1>
      <label>${t('new.name')}<input name="title" required maxlength="200" placeholder="RimWorld" autocomplete="off"></label>
      <label>${t('new.slug')}<input name="slug" required pattern="[a-z0-9][a-z0-9\\-]{0,62}" placeholder="rimworld" autocomplete="off">
        <small>${t('new.slugHint')}</small></label>
      <p class="muted">${t('new.formatAuto')} ${t('new.formatHint')}</p>
      <div class="row2">
        <label>${t('new.sourceLang')}<input name="sourceLang" value="en" required></label>
        <div class="field"><span class="field-label">${t('new.languages')}</span>${langPicker('languages', ['ru'])}<small>${t('new.languagesHint')}</small></div>
      </div>
      <label>${t('info.description')} <span class="muted">(${t('info.optional')})</span><textarea name="description" rows="3" maxlength="5000" placeholder="${esc(t('info.descriptionPh'))}"></textarea></label>
      <div class="row2">
        <label>${t('info.steam')} <span class="muted">(${t('info.optional')})</span><input name="link_steam" type="url" placeholder="https://store.steampowered.com/app/…"></label>
        <label>${t('info.site')} <span class="muted">(${t('info.optional')})</span><input name="link_site" type="url" placeholder="https://…"></label>
      </div>
      <label>${t('new.repo')}<input name="repo" placeholder="owner/name">
        <small>${t('new.repoHint')}</small></label>
      <div class="actions"><button class="btn primary">${t('new.create')}</button><a class="btn" href="#/">${t('common.cancel')}</a></div>
      <ul class="issues"></ul>
    </form>`;
  const form = view.querySelector('form');
  let slugTouched = false;
  form.slug.addEventListener('input', () => (slugTouched = true));
  form.title.addEventListener('input', () => {
    if (!slugTouched) form.slug.value = slugify(form.title.value);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    try {
      const r = await api('/games', {
        method: 'POST',
        body: {
          title: f.title.value,
          slug: f.slug.value,
          sourceLang: f.sourceLang.value.trim(),
          languages: parseLangs(f.languages.value),
          repo: f.repo.value,
          description: f.description.value,
          links: linksFromForm(form),
        },
      });
      toast(t('new.created'));
      location.hash = `#/g/${encodeURIComponent(r.slug)}/settings`;
    } catch (err) {
      form.querySelector('.issues').innerHTML = `<li class="error">${esc(err.message)}</li>`;
    }
  });
}

async function renderSettings(slug, q = new URLSearchParams()) {
  const [data, { bans }, { stats, formats: extStats }] = await Promise.all([
    api(`/games/${encodeURIComponent(slug)}/manage`),
    api(`/games/${encodeURIComponent(slug)}/bans`),
    api(`/games/${encodeURIComponent(slug)}`),
  ]);
  const { game, moderators, files, strings } = data;
  const banDate = (d) => esc(new Date(d).toLocaleString(getLocale()));
  const formats = await loadFormats(true);
  crumbs.innerHTML = `${gamesCrumb()} / <a href="#/g/${encodeURIComponent(slug)}">${esc(game.title)}</a> / ${t('set.title')}`;
  docTitle(t('set.docTitle', { game: game.title }));
  const langOptions = (withAll) =>
    (withAll ? `<option value="*">${t('set.allLangs')}</option>` : '') +
    game.languages.map((l) => `<option value="${esc(l)}">${esc(l)} — ${esc(langName(l))}</option>`).join('');

  view.innerHTML = `
    <div class="page-head"><h1>${esc(game.title)}</h1><a class="btn" href="#/g/${encodeURIComponent(slug)}">${t('set.back')}</a></div>
    <div class="settings">
      <form class="panel form" data-form="settings">
        <h2>${t('set.main')}</h2>
        <label>${t('new.name')}<input name="title" value="${esc(game.title)}" required maxlength="200"></label>
        <div class="row2">
          <div class="field"><span class="field-label">${t('new.languages')}</span>${langPicker('languages', game.languages, game.source_lang)}
            <small>${t('set.languagesHint')}</small></div>
          <label>${t('set.repo')}<input name="repo" value="${esc(game.repo || '')}" placeholder="owner/name"></label>
        </div>
        <p class="muted">${t('set.address', { slug: `<span class="mono">${esc(game.slug)}</span>`, lang: esc(game.source_lang) })}</p>
        <div class="actions"><button class="btn primary">${t('common.save')}</button></div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="info">
        <h2>${t('info.title')}</h2>
        <label>${t('info.description')}<textarea name="description" rows="4" maxlength="5000" placeholder="${esc(t('info.descriptionPh'))}">${esc(game.description || '')}</textarea></label>
        <div class="row2">
          ${LINK_KINDS.map((k) => `<label>${t('info.' + k)}<input name="link_${k}" type="url" value="${esc((game.links || []).find((l) => l.kind === k)?.url || '')}" placeholder="https://…"></label>`).join('')}
        </div>
        <label>${t('info.cover')}<input name="cover_url" type="url" value="${esc(game.cover_url || '')}" placeholder="https://…/header.jpg"><small>${t('info.coverHint')}</small></label>
        <div class="actions"><button class="btn primary">${t('common.save')}</button></div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="encodings">
        <h2>${t('enc.title')}</h2>
        <p class="muted">${t('enc.help')}</p>
        <p>${data.fileEncodings.length ? t('enc.originals', { list: data.fileEncodings.map((x) => `<span class="mono">${esc(x.encoding)}</span> (${x.files})`).join(', ') }) : `<span class="muted">${t('enc.noFiles')}</span>`}</p>
        ${game.languages
          .map((l) => `<div class="enc-row" data-lang="${esc(l)}">
            <label>${esc(langName(l))} <span class="mono muted">${esc(l)}</span>
              <select name="enc_${esc(l)}">
                <option value="">${t('enc.asSource', { enc: esc(data.fileEncodings.map((x) => x.encoding).join(', ') || 'utf-8') })}</option>
                ${data.encodingList.map((e) => `<option value="${e}" ${game.encodings?.[l] === e ? 'selected' : ''}>${e}</option>`).join('')}
              </select></label>
            <small class="enc-warn" role="alert"></small>
          </div>`)
          .join('')}
        <div class="actions"><button class="btn primary">${t('common.save')}</button></div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="formats">
        <h2>${t('fmap.title')}</h2>
        <p class="muted">${t('fmap.help')}</p>
        <div data-fmap></div>
        <div class="fmap-add"><label>${t('fmap.addExt')}<input name="newExt" placeholder=".txt" autocomplete="off" spellcheck="false"></label>
          <button type="button" class="btn small" data-fmap-add>${t('fmap.add')}</button></div>
        <div class="actions"><button class="btn primary">${t('common.save')}</button><button type="button" class="btn" data-reparse title="${esc(t('set.reparseTitle'))}">${t('set.reparse')}</button><a href="#/formats">${t('fmap.custom')}</a></div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="source">
        <h2>${t('set.source')}</h2>
        <p class="muted">${t('set.sourceNow', { files: `<b data-count="files">${files}</b>`, strings: `<b data-count="strings">${strings}</b>` })} ${t('fmap.uploadHint')}</p>
        ${filePicker()}
        <label class="check"><input type="checkbox" name="replace"> ${t('set.replace')}</label>
        <div class="actions"><button class="btn primary">${t('set.upload')}</button>${files ? `<button type="button" class="btn" data-reparse title="${esc(t('set.reparseTitle'))}">${t('set.reparse')}</button>` : ''}</div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="originals">
        <h2>${t('orig.title')}</h2>
        <p class="muted">${t('orig.help', { days: 30 })}</p>
        <div class="orig-tools">
          <input type="search" name="q" placeholder="${esc(t('orig.filter'))}" aria-label="${esc(t('orig.filter'))}" autocomplete="off">
          <div class="side-sort orig-sort"></div>
        </div>
        <div data-orig><p class="muted">${t('app.loading')}</p></div>
        <div class="orig-confirm" hidden></div>
        <div class="actions"><button type="button" class="btn bad" data-orig-del-sel disabled>${t('orig.deleteSel', { n: 0 })}</button></div>
        <div data-orig-trash></div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="translation">
        <h2>${t('set.import')}</h2>
        <p class="muted">${t('set.importHelp')}</p>
        <label>${t('set.lang')}<select name="lang">${langOptions(false)}</select></label>
        ${filePicker(textExtensions(game.format_map))}
        <label class="check"><input type="checkbox" name="overwrite"> ${t('set.overwrite')}</label>
        <div class="actions"><button class="btn primary">${t('set.importBtn')}</button></div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form accent" data-form="publish">
        <h2>${t('set.publish')}</h2>
        ${publishResult(q.get('pub'))}
        <p class="muted">${t('set.publishHelp', { repo: game.repo ? esc(game.repo) : t('set.publishRepoFallback') })}</p>
        <fieldset class="pub-langs">
          <legend>${t('pub.langs')}</legend>
          ${game.languages
            .map((l) => {
              const st = stats.find((x) => x.lang === l) || { approved: 0, total: 0 };
              // По умолчанию ничего не отмечено (кроме случая с одним языком или перехода с кнопки «Опубликовать» языка)
              const on = game.languages.length === 1 || q.get('publish') === l;
              return `<label class="check"><input type="checkbox" name="langs" value="${esc(l)}" ${on ? 'checked' : ''}> <b>${esc(langName(l))}</b> <span class="mono muted">${esc(l)}</span> <span class="muted">${t('pub.langApproved', { a: st.approved, t: st.total })}</span></label>`;
            })
            .join('')}
          <small class="muted">${t('pub.others')}</small>
        </fieldset>
        <label>${t('set.version')}<input name="version" placeholder="${esc(t('set.versionPh'))}" pattern="[0-9A-Za-z][0-9A-Za-z._\\-]{0,39}">
          <small>${t('set.versionHint')}</small></label>
        <div class="actions"><button class="btn primary" ${game.repo ? '' : 'disabled'}>${t('set.publishBtn')}</button>${game.repo ? `<a href="https://github.com/${esc(game.repo)}" target="_blank" rel="noopener">${t('set.openRepo')}</a>` : `<span class="muted">${t('set.repoFirst')}</span>`}</div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="moderators">
        <h2>${t('set.mods')}</h2>
        <ul class="mods">${moderators
          .map(
            (m) => `<li><span>${m.avatar_url ? `<img class="avatar" src="${esc(m.avatar_url)}&s=40" alt="">` : ''}<b>${esc(m.login)}</b>
              <span class="muted">${m.lang === '*' ? t('set.modAll') : esc(m.lang)}</span></span>
              <button type="button" class="link" data-act="mod-remove" data-login="${esc(m.login)}" data-lang="${esc(m.lang)}">${t('common.remove')}</button></li>`,
          )
          .join('')}</ul>
        <div class="row2">
          <label>${t('set.login')}<input name="login" placeholder="nickname" required><small>${t('set.loginHint')}</small></label>
          <label>${t('set.rights')}<select name="lang">${langOptions(true)}</select></label>
        </div>
        <div class="actions"><button class="btn primary">${t('set.assign')}</button></div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="bans">
        <h2>${t('bans.title')}</h2>
        <p class="muted">${t('bans.help')}</p>
        ${bans.length ? `<ul class="mods">${bans
          .map(
            (b) => `<li><span><b>${esc(b.login)}</b>
              <span class="muted">${esc(b.reason)} · ${b.until ? t('bans.until', { date: banDate(b.until) }) : t('bans.permanent')}${b.by ? ' · ' + t('bans.by', { name: esc(b.by) }) : ''}</span></span>
              <button type="button" class="link" data-act="ban-remove" data-id="${b.id}">${t('bans.unban')}</button></li>`,
          )
          .join('')}</ul>` : `<p class="muted">${t('bans.none')}</p>`}
        <div class="row2">
          <label>${t('set.login')}<input name="login" placeholder="nickname" required value="${esc(q.get('ban') || '')}" autocomplete="off"></label>
          <label>${t('bans.duration')}<select name="days">
            <option value="1">${t('bans.d1')}</option><option value="7" selected>${t('bans.d7')}</option><option value="30">${t('bans.d30')}</option><option value="">${t('bans.forever')}</option>
          </select></label>
        </div>
        <label>${t('bans.reason')}<input name="reason" required maxlength="500" placeholder="${esc(t('bans.reasonPh'))}"></label>
        <label class="check"><input type="checkbox" name="purge"> ${t('bans.purge')}</label>
        <div class="actions"><button class="btn bad">${t('bans.submit')}</button></div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="rules">
        <h2>${t('set.rules')}</h2>
        <p class="muted">${t('set.rulesHelp')}</p>
        <textarea name="rules" class="mono" rows="8" spellcheck="false">${esc(JSON.stringify(game.rules && Object.keys(game.rules).length ? game.rules : { [game.languages[0]]: [{ pattern: '\\s-\\s', message: 'Между словами нужно длинное тире —', level: 'warn' }] }, null, 2))}</textarea>
        <div class="actions"><button class="btn primary">${t('set.rulesSave')}</button></div>
        <ul class="issues"></ul>
      </form>

      ${me?.is_admin ? `
      <form class="panel form danger" data-form="delete">
        <h2>${t('set.delete')}</h2>
        <p class="muted">${t('set.deleteHelp')}</p>
        <label><span>${t('set.deleteConfirm', { slug: `<b class="mono">${esc(game.slug)}</b>` })}</span><input name="confirm" autocomplete="off"></label>
        <div class="actions"><button class="btn bad">${t('set.deleteBtn')}</button></div>
        <ul class="issues"></ul>
      </form>` : ''}
    </div>`;

  const forms = Object.fromEntries([...view.querySelectorAll('form[data-form]')].map((f) => [f.dataset.form, f]));
  const report = (form, items) => (form.querySelector('.issues').innerHTML = items.map(([lvl, msg]) => `<li class="${lvl}">${esc(msg)}</li>`).join(''));
  const busy = (form, on) => form.querySelectorAll('button').forEach((b) => (b.disabled = on));
  const onSubmit = (name, fn) =>
    forms[name]?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = forms[name];
      busy(form, true);
      try {
        await fn(form);
      } catch (err) {
        report(form, [['error', err.message]]);
      } finally {
        busy(form, false);
      }
    });

  // ---- Форматы файлов: таблица «расширение → формат» ----
  let exts = extStats;
  const extRow = (ext, info) => {
    const inMap = Object.prototype.hasOwnProperty.call(game.format_map || {}, ext);
    const sel = inMap ? game.format_map[ext] : '';
    const stale = info && info.strings + info.files > 0 && info.parsed?.length && info.parsed.some((p) => p !== (info.format ?? RAW));
    const fallback = (game.format_map || {})['*'] ?? game.format;
    return `<tr data-ext="${esc(ext)}">
      <td class="mono">${ext === '*' ? `* <span class="muted">${t('fmap.other')}</span>` : esc(ext)}</td>
      <td class="num">${info ? info.files : '—'}</td>
      <td class="num">${info ? info.strings : '—'}</td>
      <td><select name="fmt_${esc(ext)}" aria-label="${esc(ext)}" title="${esc(sel && sel !== RAW ? fmtInfo(formats, sel).hint : '')}">${mapOptions(formats, sel, ext === '*' ? t('fmap.notSet') : t('fmap.byDefault', { name: fallback ? formatTitle(formats, fallback) : t('fmap.raw') }))}</select>
        ${stale ? `<small class="fmap-stale">${t('fmap.stale')}</small>` : ''}</td>
    </tr>`;
  };
  const renderFormatMap = () => {
    const box = forms.formats.querySelector('[data-fmap]');
    const byExt = Object.fromEntries(exts.map((x) => [x.ext, x]));
    const list = [...new Set([...exts.map((x) => x.ext).filter(Boolean), ...Object.keys(game.format_map || {}).filter((k) => k !== '*')])].sort();
    const noExt = byExt[''];
    box.innerHTML = `<table class="fmap-table">
      <thead><tr><th>${t('fmap.ext')}</th><th class="num">${t('fmap.files')}</th><th class="num">${t('fmap.strings')}</th><th>${t('fmap.format')}</th></tr></thead>
      <tbody>${list.map((x) => extRow(x, byExt[x])).join('')}${extRow('*', null)}</tbody></table>
      ${noExt ? `<p class="muted">${t('fmap.noExt', { n: noExt.files })}</p>` : ''}
      ${list.length ? '' : `<p class="muted">${t('fmap.empty')}</p>`}`;
  };
  const refreshFormats = async () => {
    const fresh = await api(`/games/${encodeURIComponent(slug)}`);
    game.format_map = fresh.game.format_map;
    exts = fresh.formats;
    renderFormatMap();
    if (forms.originals.dataset.loaded) await loadOrigLater();
  };
  // список оригиналов (ниже) перечитывается после загрузки и пересчёта
  let loadOrigLater = async () => {};
  renderFormatMap();
  forms.formats.querySelector('[data-fmap-add]').addEventListener('click', () => {
    const f = forms.formats;
    let ext = f.newExt.value.trim().toLowerCase();
    if (ext && !ext.startsWith('.')) ext = '.' + ext;
    if (!/^\.[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*$/.test(ext)) return report(f, [['error', t('fmap.badExt')]]);
    if (!f.querySelector(`tr[data-ext="${CSS.escape(ext)}"]`)) {
      const cands = formatsForExt(formats, ext);
      game.format_map = { ...(game.format_map || {}), [ext]: cands[0]?.slug || RAW };
      renderFormatMap();
    }
    f.newExt.value = '';
    report(f, []);
  });
  onSubmit('formats', async (f) => {
    const format_map = {};
    f.querySelectorAll('tr[data-ext]').forEach((tr) => {
      const v = tr.querySelector('select').value;
      if (v) format_map[tr.dataset.ext] = v;
    });
    const r = await api(`/games/${encodeURIComponent(slug)}/settings`, { method: 'POST', body: { format_map, reparse: true } });
    await refreshFormats();
    const rp = r.reparsed;
    report(f, rp ? [['ok', t('set.reparsed', rp)]] : r.reparse ? [['warn', t('fmap.needReparse', { n: r.reparse })]] : [['ok', t('common.saved')]]);
    f.querySelector('[data-reparse]')?.classList.toggle('primary', !!r.reparse);
  });

  // Предупреждение: в выбранной (или исходной) кодировке нет букв языка — предлагаем подходящие
  const encWarn = (row) => {
    const l = row.dataset.lang;
    const chosen = row.querySelector('select').value;
    const targets = chosen ? [chosen] : data.fileEncodings.map((x) => x.encoding);
    const bad = targets.filter((e) => (data.encodingSupport[l] || []).includes(e));
    const ok = data.encodingList.filter((e) => !(data.encodingSupport[l] || []).includes(e) && !e.startsWith('utf-'));
    row.querySelector('.enc-warn').textContent = bad.length
      ? t('enc.warn', { enc: bad.join(', '), lang: langName(l), suggest: [...ok.slice(0, 2), 'utf-8'].join(', ') })
      : '';
  };
  forms.encodings.querySelectorAll('.enc-row').forEach((row) => {
    encWarn(row);
    row.querySelector('select').addEventListener('change', () => encWarn(row));
  });
  onSubmit('encodings', async (f) => {
    const encodings = Object.fromEntries(game.languages.map((l) => [l, f.elements[`enc_${l}`].value]));
    await api(`/games/${encodeURIComponent(slug)}/settings`, { method: 'POST', body: { encodings } });
    report(f, [['ok', t('common.saved')]]);
  });

  onSubmit('info', async (f) => {
    await api(`/games/${encodeURIComponent(slug)}/settings`, {
      method: 'POST',
      body: { description: f.description.value, cover_url: f.cover_url.value, links: linksFromForm(f) },
    });
    report(f, [['ok', t('common.saved')]]);
  });

  onSubmit('settings', async (f) => {
    // Убрать язык с утверждёнными переводами сервер разрешает только с force — второе нажатие «Сохранить» подтверждает
    try {
      await api(`/games/${encodeURIComponent(slug)}/settings`, {
        method: 'POST',
        body: { title: f.title.value, languages: parseLangs(f.languages.value), repo: f.repo.value, force: f.dataset.force === '1' },
      });
    } catch (err) {
      if (err.status === 422 && f.dataset.force !== '1' && game.languages.some((l) => !parseLangs(f.languages.value).includes(l))) {
        f.dataset.force = '1';
        throw new Error(`${err.message} ${t('set.forceHint')}`);
      }
      throw err;
    }
    toast(t('common.saved'));
    renderSettings(slug);
  });

  onSubmit('source', async (f) => {
    const { files, skipped } = await collectFiles(f, { map: game.format_map || {}, formats });
    if (!files.length) throw new Error(skipped.length ? t('fmap.tooBig', { list: skipped.join(', ') }) : t('set.noFiles', { ext: '' }));
    const total = { added: 0, changed: 0, removed: 0, unchanged: 0, raw: 0 };
    const errors = [];
    const assigned = {};
    const parts = batches(files);
    for (let i = 0; i < parts.length; i++) {
      report(f, [['warn', t('set.uploading', { i: i + 1, n: parts.length })]]);
      const last = i === parts.length - 1;
      const r = await api(`/games/${encodeURIComponent(slug)}/source`, {
        method: 'POST',
        body: { files: parts[i], paths: last && f.replace.checked ? files.map((x) => x.path) : undefined },
      });
      for (const k of Object.keys(total)) total[k] += r[k] || 0;
      errors.push(...r.errors);
      Object.assign(assigned, r.formats || {});
    }
    const newExts = Object.entries(assigned);
    const rawExts = newExts.filter(([, v]) => v === RAW).map(([k]) => k);
    const textFiles = files.filter((x) => !x.data);
    report(f, [
      ['ok', t('set.uploadDone', total)],
      ...(total.raw ? [['ok', t('fmap.rawCount', { n: total.raw })]] : []),
      ...(newExts.length ? [['ok', t('fmap.assigned', { list: newExts.map(([k, v]) => `${k} → ${formatTitle(formats, v)}`).join(', ') })]] : []),
      ...(rawExts.length ? [['warn', t('fmap.rawNotice', { list: rawExts.join(', ') })]] : []),
      ...(skipped.length ? [['warn', t('fmap.tooBig', { list: skipped.join(', ') })]] : []),
      ...(textFiles.length ? [['ok', t('enc.detected', { list: encodingSummary(textFiles) })]] : []),
      ...errors.map((e) => ['error', e]),
    ]);
    toast(t('set.sourceUploaded'));
    const fresh = await api(`/games/${encodeURIComponent(slug)}/manage`);
    f.querySelector('[data-count=files]').textContent = fresh.files;
    f.querySelector('[data-count=strings]').textContent = fresh.strings;
    await refreshFormats();
  });

  // «Пересчитать строки по формату»: заново разобрать сохранённые оригиналы по текущей карте форматов
  for (const f of [forms.formats, forms.source]) {
    f.querySelector('[data-reparse]')?.addEventListener('click', async () => {
      busy(f, true);
      try {
        const r = await api(`/games/${encodeURIComponent(slug)}/reparse`, { method: 'POST' });
        f.querySelector('[data-reparse]').classList.remove('primary');
        const fresh = await api(`/games/${encodeURIComponent(slug)}/manage`);
        forms.source.querySelector('[data-count=files]').textContent = fresh.files;
        forms.source.querySelector('[data-count=strings]').textContent = fresh.strings;
        await refreshFormats();
        report(f, [['ok', t('set.reparsed', r)], ...r.errors.map((e) => ['error', e])]);
      } catch (err) {
        report(f, [['error', err.message]]);
      } finally {
        busy(f, false);
      }
    });
  }

  // ---- Оригинальные файлы: список, фильтр, сортировка, скачивание, удаление в корзину и возврат ----
  const orig = { files: [], trash: [], days: 30, q: '', sort: { key: 'name', dir: 'asc' }, sel: new Set() };
  const of = forms.originals;
  const sizeFmt = (n) =>
    n < 1024 ? new Intl.NumberFormat(getLocale(), { style: 'unit', unit: 'byte' }).format(n)
      : new Intl.NumberFormat(getLocale(), { style: 'unit', unit: n < 1048576 ? 'kilobyte' : 'megabyte', maximumFractionDigits: 1 }).format(n / (n < 1048576 ? 1024 : 1048576));
  const ORIG_SORTS = ['name', 'size', 'strings'];
  const origVisible = () => {
    const q = orig.q.toLowerCase();
    const k = orig.sort.dir === 'asc' ? 1 : -1;
    const val = (f) => (orig.sort.key === 'name' ? f.path.toLowerCase() : f[orig.sort.key]);
    return orig.files
      .filter((f) => !q || f.path.toLowerCase().includes(q) || String(f.format).toLowerCase().includes(q))
      .sort((a, b) => (val(a) < val(b) ? -k : val(a) > val(b) ? k : a.path.localeCompare(b.path, undefined, { numeric: true })));
  };
  const renderOrig = () => {
    of.querySelector('.orig-sort').innerHTML = ORIG_SORTS.map((k) => {
      const title = t('orig.sort.' + k);
      const on = orig.sort.key === k;
      return `<button type="button" data-orig-sort="${k}" class="${on ? 'on' : ''}" title="${esc(t('side.sort', { col: title }))}">${title}${on ? (orig.sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button>`;
    }).join('');
    const list = origVisible();
    for (const p of [...orig.sel]) if (!orig.files.some((f) => f.path === p)) orig.sel.delete(p);
    const allOn = list.length > 0 && list.every((f) => orig.sel.has(f.path));
    of.querySelector('[data-orig]').innerHTML = !orig.files.length
      ? `<p class="muted">${t('orig.none')}</p>`
      : !list.length
        ? `<p class="muted">${t('orig.noMatch')}</p>`
        : `<div class="orig-scroll"><table class="fmap-table orig-table">
          <thead><tr><th><input type="checkbox" data-orig-all ${allOn ? 'checked' : ''} aria-label="${esc(t('orig.selectAll'))}"></th><th>${t('orig.sort.name')}</th><th class="orig-fmt">${t('fmap.format')}</th><th class="orig-enc">${t('orig.colEnc')}</th><th class="num">${t('orig.sort.size')}</th><th class="num">${t('orig.sort.strings')}</th><th></th></tr></thead>
          <tbody>${list
            .map((f) => {
              const i = f.path.lastIndexOf('/');
              return `<tr data-path="${esc(f.path)}">
                <td><input type="checkbox" data-orig-pick ${orig.sel.has(f.path) ? 'checked' : ''} aria-label="${esc(f.path)}"></td>
                <td class="orig-path">${i >= 0 ? `<span class="dir">${esc(f.path.slice(0, i + 1))}</span>` : ''}${esc(f.path.slice(i + 1))}</td>
                <td class="orig-fmt">${esc(f.format ? formatTitle(formats, f.format) : '—')}</td>
                <td class="orig-enc mono">${f.data || f.encoding === 'binary' ? '—' : esc(f.encoding)}</td>
                <td class="num">${sizeFmt(f.size)}</td>
                <td class="num">${f.strings}</td>
                <td class="orig-act"><button type="button" class="link" data-orig-dl title="${esc(t('orig.download'))}">${t('orig.download')}</button>
                  <button type="button" class="link bad" data-orig-del>${t('orig.delete')}</button></td>
              </tr>`;
            })
            .join('')}</tbody></table></div>`;
    const selBtn = of.querySelector('[data-orig-del-sel]');
    selBtn.disabled = !orig.sel.size;
    selBtn.textContent = t('orig.deleteSel', { n: orig.sel.size });
    const trash = of.querySelector('[data-orig-trash]');
    trash.innerHTML = orig.trash.length
      ? `<details class="orig-trash"><summary>${t('orig.trash', { n: orig.trash.length, days: orig.days })}</summary>
          <ul class="mods">${orig.trash
            .map((x) => `<li data-path="${esc(x.path)}"><span><span class="mono">${esc(x.path)}</span>
              <span class="muted">${t('orig.deletedAt', { date: esc(new Date(x.deleted_at).toLocaleString(getLocale())), by: esc(x.deleted_by || '—') })}</span></span>
              <button type="button" class="link" data-orig-restore>${t('orig.restore')}</button></li>`)
            .join('')}</ul>
          <div class="actions"><button type="button" class="btn small" data-orig-restore-all>${t('orig.restoreAll')}</button></div></details>`
      : '';
  };
  const loadOrig = async () => {
    const r = await api(`/games/${encodeURIComponent(slug)}/source/files`);
    orig.files = r.files;
    orig.trash = r.trash;
    orig.days = r.trashDays;
    of.dataset.loaded = '1';
    renderOrig();
  };
  loadOrigLater = loadOrig;
  const afterFilesChange = async () => {
    const fresh = await api(`/games/${encodeURIComponent(slug)}/manage`);
    forms.source.querySelector('[data-count=files]').textContent = fresh.files;
    forms.source.querySelector('[data-count=strings]').textContent = fresh.strings;
    await refreshFormats();
  };
  const restoreFiles = async (paths) => {
    const r = await api(`/games/${encodeURIComponent(slug)}/source/restore`, { method: 'POST', body: { paths } });
    await afterFilesChange();
    return r;
  };
  const deleteFiles = async (paths) => {
    const r = paths.length === 1
      ? await api(`/games/${encodeURIComponent(slug)}/source?file=${encodeURIComponent(paths[0])}`, { method: 'DELETE' })
      : await api(`/games/${encodeURIComponent(slug)}/source/delete`, { method: 'POST', body: { paths } });
    paths.forEach((p) => orig.sel.delete(p));
    await afterFilesChange();
    toast(t('orig.deleted', { files: r.deleted.length, strings: r.strings }), { label: t('undo.deleteFiles'), run: () => restoreFiles(r.deleted) });
  };
  // Подтверждение прямо в панели (без window.confirm)
  const askDelete = (paths) => {
    const box = of.querySelector('.orig-confirm');
    const strings = orig.files.filter((f) => paths.includes(f.path)).reduce((n, f) => n + f.strings, 0);
    box.hidden = false;
    box.innerHTML = `<span>${t('orig.confirm', { n: paths.length, strings, name: esc(paths[0]) })}</span>
      <button type="button" class="btn small bad" data-orig-yes>${t('orig.confirmYes')}</button>
      <button type="button" class="btn small" data-orig-no>${t('common.cancel')}</button>`;
    box.querySelector('[data-orig-no]').onclick = () => { box.hidden = true; box.innerHTML = ''; };
    box.querySelector('[data-orig-yes]').onclick = async () => {
      busy(of, true);
      try {
        await deleteFiles(paths);
        box.hidden = true;
        box.innerHTML = '';
        report(of, []);
      } catch (err) {
        report(of, [['error', err.message]]);
      } finally {
        busy(of, false);
        renderOrig();
      }
    };
    box.scrollIntoView({ block: 'nearest' });
  };
  const downloadOriginal = async (path) => {
    const token = store.get('token');
    const res = await fetch(`${API}/games/${encodeURIComponent(slug)}/source/raw?file=${encodeURIComponent(path)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('app.error', { status: res.status }));
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: path.split('/').pop() });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  of.addEventListener('submit', (e) => e.preventDefault());
  of.q.addEventListener('input', () => {
    orig.q = of.q.value.trim();
    renderOrig();
  });
  of.addEventListener('change', (e) => {
    if (e.target.matches('[data-orig-all]')) {
      for (const f of origVisible()) e.target.checked ? orig.sel.add(f.path) : orig.sel.delete(f.path);
      renderOrig();
    } else if (e.target.matches('[data-orig-pick]')) {
      const p = e.target.closest('tr').dataset.path;
      e.target.checked ? orig.sel.add(p) : orig.sel.delete(p);
      renderOrig();
    }
  });
  of.addEventListener('click', async (e) => {
    const sortBtn = e.target.closest('[data-orig-sort]');
    if (sortBtn) {
      const k = sortBtn.dataset.origSort;
      orig.sort = orig.sort.key === k ? { key: k, dir: orig.sort.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: k === 'name' ? 'asc' : 'desc' };
      return renderOrig();
    }
    const path = e.target.closest('[data-path]')?.dataset.path;
    try {
      if (e.target.closest('[data-orig-del]')) askDelete([path]);
      else if (e.target.closest('[data-orig-del-sel]')) askDelete([...orig.sel]);
      else if (e.target.closest('[data-orig-dl]')) await downloadOriginal(path);
      else if (e.target.closest('[data-orig-restore]') || e.target.closest('[data-orig-restore-all]')) {
        const paths = e.target.closest('[data-orig-restore-all]') ? orig.trash.map((x) => x.path) : [path];
        const r = await restoreFiles(paths);
        toast(t('orig.restored', { files: r.files, strings: r.strings }));
        report(of, [...(r.skipped.length ? [['warn', t('orig.skipped', { list: r.skipped.join(', ') })]] : []), ...r.errors.map((x) => ['error', x])]);
      }
    } catch (err) {
      report(of, [['error', err.message]]);
    }
  });
  loadOrig().catch((err) => report(of, [['error', err.message]]));

  onSubmit('translation', async (f) => {
    // готовый перевод — только текстовые файлы переводимых форматов (картинки и «как есть» пропускаются)
    const { files } = await collectFiles(f, { map: game.format_map || {}, formats, translation: true });
    if (!files.length) throw new Error(t('set.noFiles', { ext: textExtensions(game.format_map).join(', ') }));
    const total = { imported: 0, skipped: 0, unknown: 0 };
    for (const part of batches(files)) {
      const r = await api(`/games/${encodeURIComponent(slug)}/translation`, {
        method: 'POST',
        body: { lang: f.lang.value, files: part, overwrite: f.overwrite.checked },
      });
      for (const k of Object.keys(total)) total[k] += r[k];
    }
    report(f, [['ok', t('set.imported', total)]]);
  });

  onSubmit('publish', async (f) => {
    if (!f.querySelector('input[name=langs]:checked')) throw new Error(t('pub.chooseLang'));
    const r = await api(`/games/${encodeURIComponent(slug)}/publish/start`, {
      method: 'POST',
      body: { version: f.version.value.trim(), langs: [...f.querySelectorAll('input[name=langs]:checked')].map((x) => x.value), return: location.origin + location.pathname },
    });
    report(f, [['warn', t('set.toGithub')]]);
    location.href = r.url;
  });
  if (q.get('pub') || q.get('publish')) forms.publish.scrollIntoView({ block: 'center' });

  onSubmit('bans', async (f) => {
    const purge = f.purge.checked;
    const r = await api(`/games/${encodeURIComponent(slug)}/bans`, {
      method: 'POST',
      body: { login: f.login.value.trim(), reason: f.reason.value.trim(), days: f.days.value ? Number(f.days.value) : undefined, purge },
    });
    toast(t('bans.done', { login: r.login }) + (purge ? ' · ' + t('bans.purged', r.purged) : ''));
    renderSettings(slug);
  });
  // Пришли по ссылке «забанить» со страницы перевода — форма уже заполнена логином
  if (q.get('ban')) {
    forms.bans.scrollIntoView({ block: 'center' });
    forms.bans.reason.focus();
  }

  onSubmit('moderators', async (f) => {
    await api(`/games/${encodeURIComponent(slug)}/moderators`, { method: 'POST', body: { login: f.login.value, lang: f.lang.value } });
    toast(t('set.modAssigned'));
    renderSettings(slug);
  });

  onSubmit('rules', async (f) => {
    let rules;
    try {
      rules = JSON.parse(f.rules.value || '{}');
    } catch (err) {
      throw new Error(t('set.notJson', { error: err.message }));
    }
    await api(`/games/${encodeURIComponent(slug)}/settings`, { method: 'POST', body: { rules } });
    report(f, [['ok', t('set.rulesSaved')]]);
  });

  onSubmit('delete', async (f) => {
    if (f.confirm.value.trim() !== game.slug) throw new Error(t('set.slugMismatch'));
    await api(`/games/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    toast(t('set.deleted'));
    location.hash = '#/';
  });
}

/** Расширения, которые в карте игры переводятся (не «как есть») — для выбора файлов готового перевода. */
const textExtensions = (map) => Object.entries(map || {}).filter(([k, v]) => k !== '*' && v !== RAW).map(([k]) => k).sort();

/** Выбор файлов. accept — только эти расширения (для готового перевода); для исходников — любые файлы. */
function filePicker(accept = []) {
  return `
    <div class="picker">
      <label class="btn small">${t('pick.files')}<input type="file" name="files" multiple ${accept.length ? `accept="${esc(accept.join(','))}"` : ''} hidden></label>
      <label class="btn small">${t('pick.folder')}<input type="file" name="folder" webkitdirectory hidden></label>
      <span class="muted picked">${t('pick.none')}</span>
    </div>
    <label>${t('enc.pick')}<select name="encoding"><option value="">${t('enc.auto')}</option>${ENCODINGS.map((e) => `<option value="${e}">${e}</option>`).join('')}</select>
      <small>${t('enc.pickHint')}</small></label>
    <label>${t('pick.prefix')}<input name="prefix" placeholder="${esc(t('pick.prefixPh'))}">
      <small>${t('pick.prefixHint')}</small></label>`;
}

// Подпись «выбрано N файлов» у пикера
document.addEventListener('change', (e) => {
  const input = e.target;
  if (!input.matches?.('.picker input[type=file]')) return;
  const form = input.closest('form');
  const n = [...form.querySelectorAll('.picker input[type=file]')].reduce((s, i) => s + i.files.length, 0);
  const label = form.querySelector('.picked');
  if (label) label.textContent = n ? t('pick.count', { n }) : t('pick.none');
});

/** Предел одного файла «как есть» (картинки и т. п.): тело запроса на Vercel ≤ ~4.5 МБ, байты идут в base64. */
const RAW_MAX_BYTES = 3_000_000;

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Прочитать выбранные файлы. Формат каждого определяет сервер по расширению; здесь решаем только, как отправить:
 * текстом (с кодировкой) или байтами — двоичные файлы, расширения «как есть» в карте игры и расширения,
 * которых не знает ни один формат (их сервер не переводит). translation — только текстовые файлы переводимых форматов.
 * Возвращает { files, skipped } — skipped: слишком большие файлы «как есть».
 */
async function collectFiles(form, { map, formats, translation = false }) {
  const prefix = form.prefix.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const files = [];
  const skipped = [];
  const add = async (file, rel) => {
    const path = [prefix, rel].filter(Boolean).join('/');
    const ext = extOf(path);
    const mapped = mappedFormat(map, path);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const binary = looksBinary(bytes);
    const raw = binary || (mapped !== undefined ? mapped === RAW : !formatsForExt(formats, ext).length);
    if (translation && (binary || mapped === RAW)) return;
    if (raw && !translation) {
      if (bytes.length > RAW_MAX_BYTES) return skipped.push(path);
      files.push({ path, content: '', data: toBase64(bytes) });
      return;
    }
    // Кодировка: выбранная вручную или определённая по байтам (BOM / корректный UTF-8 / однобайтовая).
    // Переводы строк не трогаем — файл соберётся обратно теми же байтами.
    const encoding = form.encoding?.value || detectEncoding(bytes);
    files.push({ path, content: decodeBytes(bytes, encoding), encoding });
  };
  for (const f of form.files.files) await add(f, f.name);
  for (const f of form.folder.files) await add(f, (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name);
  return { files, skipped };
}

/** «utf-8 (12), windows-1251 (3)» — какие кодировки определились у загруженных файлов. */
function encodingSummary(files) {
  const n = {};
  for (const f of files) n[f.encoding] = (n[f.encoding] || 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1]).map(([e, k]) => `${e} (${k})`).join(', ');
}

function batches(files, limit = 3_000_000) {
  const out = [[]];
  let size = 0;
  for (const f of files) {
    const s = (f.data ? f.data.length : new Blob([f.content]).size) + f.path.length + 32;
    if (size + s > limit && out.at(-1).length) {
      out.push([]);
      size = 0;
    }
    out.at(-1).push(f);
    size += s;
  }
  return out;
}

// ---------- скачивание перевода .zip (собирается в браузере) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Простой zip без сжатия (метод store) — без библиотек. */
function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const data = f.bytes ?? enc.encode(f.content);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 имена
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(local.buffer, name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const cenSize = central.reduce((s, b) => s + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end.buffer], { type: 'application/zip' });
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act="download"], [data-act="mod-remove"], [data-act="ban-remove"]');
  if (!el) return;
  try {
    if (el.dataset.act === 'download') {
      el.disabled = true;
      const { slug, lang } = el.dataset;
      // binary=1: файлы уже в нужной кодировке (с BOM, если он есть) — в архив кладём ровно эти байты
      const r = await api(`/games/${encodeURIComponent(slug)}/export?lang=${encodeURIComponent(lang)}&binary=1`);
      if (!r.files.length) return toast(t('dl.none'));
      const url = URL.createObjectURL(makeZip(r.files.map((f) => ({ path: `${lang}/${f.path}`, bytes: Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)) }))));
      const a = Object.assign(document.createElement('a'), { href: url, download: `${slug}-${lang}.zip` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast(t('dl.done', { translated: r.translated, total: r.total }));
    } else if (el.dataset.act === 'ban-remove') {
      const slug = parseRoute().parts[1];
      await api(`/games/${encodeURIComponent(slug)}/bans?id=${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' });
      toast(t('bans.removed'));
      renderSettings(slug);
    } else {
      const slug = parseRoute().parts[1];
      await api(`/games/${encodeURIComponent(slug)}/moderators`, { method: 'POST', body: { login: el.dataset.login, lang: el.dataset.lang, remove: true } });
      toast(t('set.modRemoved'));
      renderSettings(slug);
    }
  } catch (err) {
    toast(err.message);
  } finally {
    el.disabled = false;
  }
});

// ---------- форматы файлов: список и редактор ----------

async function renderFormats(slug, q) {
  const formats = await loadFormats(true);
  crumbs.innerHTML = `${gamesCrumb()} / <a href="#/formats">${t('fmt.crumb')}</a>${slug ? ' / ' + esc(slug === 'new' ? t('fmt.newTitle') : slug) : ''}`;
  docTitle(t('fmt.title'));
  if (!slug) {
    view.innerHTML = `
      <div class="page-head"><h1>${t('fmt.title')}</h1>${me ? `<a class="btn primary" href="#/formats/new">${t('fmt.new')}</a>` : ''}</div>
      <p class="muted">${t('fmt.intro')}</p>
      <div class="formats">${formats
        .map(
          (f) => `<a class="card fmt" href="#/formats/${encodeURIComponent(f.slug)}">
            <b>${esc(f.title)}</b>
            <span class="muted mono">${esc(f.slug)} · ${esc(f.extensions.join(', '))}</span>
            <span class="badge-kind ${f.kind}">${esc(kindTitle(f.kind))}${f.owner ? ' · ' + esc(f.owner) : ''}</span>
          </a>`,
        )
        .join('')}</div>`;
    return;
  }

  const isNew = slug === 'new';
  const base = isNew ? formats.find((f) => f.slug === (q.get('from') || 'plain-lines')) : formats.find((f) => f.slug === slug);
  if (!isNew && !base) throw new Error(t('fmt.notFound'));
  const editable = isNew || (base.kind === 'custom' && me && (me.is_admin || base.owner === me.login));
  const lineBased = isNew || base.kind !== 'builtin';
  const config = base?.config ?? { extensions: ['.txt'], mode: 'lines', skip: ['^\\s*$'] };

  view.innerHTML = `
    <form class="panel form" data-form="format">
      <div class="page-head"><h1>${isNew ? t('fmt.newTitle') : esc(base.title)}</h1>
        ${!isNew && lineBased && me ? `<a class="btn" href="#/formats/new?from=${encodeURIComponent(base.slug)}">${t('fmt.copy')}</a>` : ''}</div>
      ${!isNew ? `<p class="muted">${esc(kindTitle(base.kind))} · <span class="mono">${esc(base.slug)}</span>${base.owner ? ' · ' + t('fmt.byAuthor', { name: esc(base.owner) }) : ''}</p>` : ''}
      ${!lineBased ? `<p>${t('fmt.builtinNote', { ext: esc(base.extensions.join(', ')) })}</p>` : ''}
      ${isNew ? `
        <div class="row2">
          <label>${t('fmt.code')}<input name="slug" required pattern="[a-z0-9][a-z0-9\\-]{1,40}" placeholder="my-game-dialogs" autocomplete="off"><small>${t('fmt.codeHint')}</small></label>
          <label>${t('fmt.name')}<input name="title" required maxlength="120" placeholder="${esc(t('fmt.namePh'))}"></label>
        </div>
        <label>${t('fmt.base')}<select name="from">${formats
          .filter((f) => f.kind !== 'builtin')
          .map((f) => `<option value="${esc(f.slug)}" ${f.slug === base?.slug ? 'selected' : ''}>${esc(f.title)}</option>`)
          .join('')}</select></label>` : editable ? `<label>${t('fmt.name')}<input name="title" value="${esc(base.title)}" maxlength="120"></label>` : ''}
      ${lineBased ? `
        <label>${t('fmt.config')}<textarea name="config" class="mono" rows="10" spellcheck="false" ${editable ? '' : 'readonly'}>${esc(JSON.stringify(config, null, 2))}</textarea></label>
        ${t('fmt.help')}` : ''}
      <h2>${t('fmt.test')}</h2>
      <div class="picker"><label class="btn small">${t('fmt.pickFile')}<input type="file" name="sample" hidden></label><span class="muted picked-sample">${t('fmt.noFile')}</span></div>
      <div class="preview"></div>
      ${editable ? `<div class="actions"><button class="btn primary">${isNew ? t('fmt.create') : t('common.save')}</button></div>` : ''}
      <ul class="issues"></ul>
    </form>`;

  const form = view.querySelector('form');
  const report = (items) => (form.querySelector('.issues').innerHTML = items.map(([l, m]) => `<li class="${l}">${esc(m)}</li>`).join(''));
  const readConfig = () => {
    try {
      return JSON.parse(form.config.value);
    } catch (e) {
      throw new Error(t('fmt.notJson', { error: e.message }));
    }
  };
  form.from?.addEventListener('change', () => {
    const f = formats.find((x) => x.slug === form.from.value);
    if (f?.config) form.config.value = JSON.stringify(f.config, null, 2);
    runPreview();
  });

  let sample = null;
  async function runPreview() {
    const box = form.querySelector('.preview');
    if (!sample) return;
    if (!me) return (box.innerHTML = `<p class="muted">${t('fmt.loginToTest')}</p>`);
    try {
      const body = { path: sample.name, content: sample.content, ...(lineBased ? { config: readConfig() } : { format: base.slug }) };
      const r = await api('/formats/preview', { method: 'POST', body });
      box.innerHTML = `
        <ul class="issues">
          <li class="${r.matches ? 'ok' : 'warn'}">${r.matches ? t('fmt.extOk') : t('fmt.extBad')}</li>
          <li class="${r.count ? 'ok' : 'warn'}">${t('fmt.found', { n: r.count })}</li>
          ${r.roundTrip === null ? '' : `<li class="${r.roundTrip ? 'ok' : 'error'}">${r.roundTrip ? t('fmt.roundOk') : t('fmt.roundBad')}</li>`}
        </ul>
        ${r.count ? `<table class="ptable"><thead><tr><th>${t('fmt.colKey')}</th><th>${t('fmt.colContext')}</th><th>${t('fmt.colText')}</th></tr></thead><tbody>${r.strings
          .slice(0, 60)
          .map((x) => `<tr><td class="mono">${esc(x.key)}</td><td class="muted">${esc(x.context || '')}</td><td>${esc(x.source)}</td></tr>`)
          .join('')}</tbody></table>${r.count > 60 ? `<p class="muted">${t('fmt.more', { n: r.count - 60 })}</p>` : ''}` : ''}`;
    } catch (e) {
      box.innerHTML = `<ul class="issues"><li class="error">${esc(e.message)}</li></ul>`;
    }
  }
  form.sample.addEventListener('change', async () => {
    const file = form.sample.files[0];
    if (!file) return;
    sample = { name: file.name, content: await file.text() };
    form.querySelector('.picked-sample').textContent = file.name;
    runPreview();
  });
  let timer;
  form.config?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(runPreview, 600);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const config = readConfig();
      if (isNew) {
        await api('/formats', { method: 'POST', body: { slug: form.slug.value.trim(), title: form.title.value, config } });
        toast(t('fmt.created'));
        location.hash = `#/formats/${encodeURIComponent(form.slug.value.trim())}`;
      } else {
        const r = await api(`/formats/${encodeURIComponent(base.slug)}`, { method: 'POST', body: { title: form.title?.value, config } });
        report([['ok', t('common.saved')], ...(r.games.length ? [['warn', t('fmt.usedBy', { games: r.games.join(', ') })]] : [])]);
      }
    } catch (err) {
      report([['error', err.message]]);
    }
  });
}


function publishResult(raw) {
  if (!raw) return '';
  let r;
  try {
    r = JSON.parse(raw);
  } catch {
    return '';
  }
  if (r.error) return `<ul class="issues"><li class="error">${t('pub.failed', { error: esc(r.error) })}</li></ul>`;
  const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const parts = [
    t(r.created ? 'pub.created' : 'pub.repo', { link: link(r.url, r.repo) }),
    r.commit ? t('pub.commit', { link: link(`${r.url}/commit/${r.commit}`, r.commit.slice(0, 7)), n: r.files }) : t('pub.noChanges'),
  ];
  // Итог по каждому языку: релиз, тег уже есть, нечего выпускать, ошибка или просто обновлён в репо
  const level = { released: 'ok', committed: 'ok', exists: 'warn', skipped: 'warn', error: 'error' };
  const langs = (r.langs || []).map((x) => {
    const name = esc(langName(x.lang));
    const msg =
      x.status === 'released' ? t('pub.res.released', { lang: name, link: link(`${r.url}/releases/tag/${x.tag}`, x.tag) })
      : x.status === 'exists' ? t('pub.res.exists', { lang: name, tag: esc(x.tag) })
      : x.status === 'skipped' ? t('pub.res.skipped', { lang: name })
      : x.status === 'error' ? t('pub.res.error', { lang: name, error: esc(x.error || '') })
      : t('pub.res.committed', { lang: name });
    return `<li class="${level[x.status] || 'ok'}">${msg}</li>`;
  });
  return `<ul class="issues"><li class="ok">${t('pub.done')} ${parts.join(' ')}</li>${langs.join('')}</ul>`;
}

// ---------- токены и подключение MCP ----------
async function renderTokens() {
  crumbs.innerHTML = `${gamesCrumb()} / ${t('tok.title')}`;
  docTitle(t('tok.title'));
  if (snapshot.on) {
    view.innerHTML = `<div class="empty">${t('snap.readOnly')}</div>`;
    return;
  }
  if (!me) {
    view.innerHTML = `<div class="empty"><button class="btn primary" data-act="login">${t('account.login')}</button></div>`;
    return;
  }
  const { tokens } = await api('/tokens');
  const mcpUrl = (window.FORUM_API || location.origin).replace(/\/$/, '') + '/api/mcp';
  const authHeader = `<code>Authorization: Bearer &lt;${esc(t('tok.tokenWord'))}&gt;</code>`;
  const loc = getLocale();
  view.innerHTML = `
    <div class="page-head"><h1>${t('tok.title')}</h1></div>
    <div class="settings">
      <section class="panel form">
        <h2>${t('tok.connect')}</h2>
        <p>${t('tok.intro', { ai: `<span class="ai">${t('str.ai')}</span>` })}</p>
        <div class="copy-row"><code>${esc(mcpUrl)}</code><button class="btn small" type="button" data-copy="${esc(mcpUrl)}">${t('tok.copy')}</button></div>
        <p class="muted">${t('tok.claudeApp')}</p>
        <p class="muted">${t('tok.claudeCode', { cmd: `<code>claude mcp add --transport http localization-forum ${esc(mcpUrl)}</code>`, header: `<code>--header "Authorization: Bearer &lt;${esc(t('tok.tokenWord'))}&gt;"</code>` })}</p>
        <p class="muted">${t('tok.others', { header: authHeader })}</p>
      </section>
      <form class="panel form" data-form="new-token">
        <h2>${t('tok.personal')}</h2>
        <p class="muted">${t('tok.personalHelp')}</p>
        <div class="row2"><label>${t('tok.name')}<input name="name" placeholder="${esc(t('tok.namePh'))}" maxlength="100"></label><div class="actions" style="align-self:end"><button class="btn primary">${t('tok.create')}</button></div></div>
        <div class="new-token"></div>
        <ul class="issues"></ul>
      </form>
      <section class="panel">
        <h2>${t('tok.granted')}</h2>
        ${tokens.length ? `<ul class="mods">${tokens
          .map(
            (tk) => `<li><span><b>${esc(tk.name)}</b><span class="muted">${tk.kind === 'oauth' ? t('tok.oauth') : t('tok.personalKind')} · ${t('tok.createdAt', { date: new Date(tk.created_at).toLocaleDateString(loc) })} · ${tk.last_used_at ? t('tok.usedAt', { date: new Date(tk.last_used_at).toLocaleString(loc) }) : t('tok.unused')}</span></span>
            <button class="link" data-act="token-revoke" data-id="${tk.id}">${t('tok.revoke')}</button></li>`,
          )
          .join('')}</ul>` : `<p class="muted">${t('tok.none')}</p>`}
      </section>
    </div>`;
  const form = view.querySelector('[data-form=new-token]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/tokens', { method: 'POST', body: { name: form.name.value } });
      form.querySelector('.new-token').innerHTML = `<div class="token-box"><code>${esc(r.token)}</code><button class="btn small" type="button" data-copy="${esc(r.token)}">${t('tok.copy')}</button></div><p class="muted">${t('tok.copyNow')}</p>`;
      form.name.value = '';
    } catch (err) {
      form.querySelector('.issues').innerHTML = `<li class="error">${esc(err.message)}</li>`;
    }
  });
}

document.addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      toast(t('copy.done'));
    } catch {
      toast(t('copy.failed'));
    }
    return;
  }
  const rev = e.target.closest('[data-act=token-revoke]');
  if (rev) {
    try {
      await api(`/tokens/${rev.dataset.id}`, { method: 'DELETE' });
      toast(t('tok.revoked'));
      renderTokens();
    } catch (err) {
      toast(err.message);
    }
  }
});


// ---------- список файлов: сортировка как в таблице ----------
const FILE_SORTS = ['name', 'done', 'total'];

function sortFiles(list) {
  const { key = 'name', dir = 'asc' } = uiPrefs.fileSort || {};
  const val = (f) => (key === 'done' ? (f.total ? f.approved / f.total : 0) : key === 'total' ? f.total : f.file.toLowerCase());
  const k = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x < y) return -k;
    if (x > y) return k;
    return a.file.localeCompare(b.file, undefined, { numeric: true });
  });
}

function renderSide(files, st) {
  const { slug, lang, params } = state ?? {};
  const sort = uiPrefs.fileSort || { key: 'name', dir: 'asc' };
  const head = `<div class="side-sort">${FILE_SORTS.map((k) => {
    const title = t('side.sort.' + k);
    return `<button type="button" data-act="file-sort" data-k="${k}" class="${sort.key === k ? 'on' : ''}" title="${esc(t('side.sort', { col: title }))}">${title}${sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button>`;
  }).join('')}</div>`;
  // +N — строки, у которых есть предложенные варианты, но ещё нет утверждённого перевода
  const plus = (n) => (n ? `<span class="vcount" title="${esc(t('side.votingTitle', { n }))}">+${n}</span> ` : '');
  const all = `<a href="${href(slug, lang, { ...params, file: '', page: 1 })}" class="${params.file ? '' : 'on'}"><span class="fname">${t('side.all')}</span><small>${plus(st.voting)}${st.approved}/${st.total}</small></a>`;
  const rows = sortFiles(files)
    .map((f) => {
      const i = f.file.lastIndexOf('/');
      const dir = i >= 0 ? f.file.slice(0, i + 1) : '';
      const p = f.total ? Math.round((f.approved / f.total) * 100) : 0;
      const pv = f.total ? Math.round(((f.voting || 0) / f.total) * 100) : 0;
      const title = t('side.fileTitle', { file: f.file, p }) + (f.voting ? t('side.fileVoting', { n: f.voting }) : '');
      return `<a href="${href(slug, lang, { ...params, file: f.file, page: 1 })}" class="${f.file === params.file ? 'on' : ''}" title="${esc(title)}"><span class="fname">${dir ? `<span class="dir">${esc(dir)}</span>` : ''}${esc(f.file.slice(i + 1))}</span><small class="${f.approved === f.total ? 'done' : ''}">${plus(f.voting)}${f.approved}/${f.total}</small><i class="fbar" style="width:${p}%"></i>${pv ? `<i class="fbar vbar" style="left:${p}%;width:${pv}%"></i>` : ''}</a>`;
    })
    .join('');
  return head + all + rows;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act=file-sort]');
  if (!b || !state?.files) return;
  const cur = uiPrefs.fileSort || { key: 'name', dir: 'asc' };
  // Повторный клик по той же колонке — обратный порядок; новая колонка: имя по возрастанию, числа — по убыванию
  uiPrefs.fileSort = cur.key === b.dataset.k ? { key: cur.key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key: b.dataset.k, dir: b.dataset.k === 'name' ? 'asc' : 'desc' };
  applyUi();
  document.querySelector('.side').innerHTML = renderSide(state.files, state.st);
});

// ======================================================================
// Об игре: ссылки, выбор языков, страница-обзор игры
// ======================================================================

const LINK_KINDS = ['steam', 'site', 'gog', 'itch', 'other'];

/** Ссылки из полей link_<вид> формы → [{kind, url}] для API. */
function linksFromForm(form) {
  return LINK_KINDS.map((kind) => ({ kind, url: form.elements[`link_${kind}`]?.value.trim() || '' })).filter((l) => l.url);
}

/** Проверить код нового языка; возвращает текст ошибки или ''. */
function langCodeError(code, current, sourceLang) {
  if (!LANG_CODE_RE.test(code)) return t('lp.badCode');
  if (code === sourceLang) return t('lp.isSource');
  if (current.includes(code)) return t('lp.already');
  return '';
}

/** Варианты для «добавить язык»: частые языки, кроме уже выбранных и языка оригинала. */
const langAddOptions = (current, sourceLang) =>
  `<option value="">${t('lp.pick')}</option>` +
  Object.keys(LANG_NAMES)
    .filter((c) => !current.includes(c) && c !== sourceLang)
    .map((c) => `<option value="${esc(c)}">${esc(LANG_NAMES[c])} — ${esc(c)}</option>`)
    .join('');

const langAddBox = (current, sourceLang, attr) => `
  <div class="lp-add" ${attr}>
    <select data-lp-select aria-label="${esc(t('lp.pick'))}">${langAddOptions(current, sourceLang)}</select>
    <input data-lp-code placeholder="${esc(t('lp.codePh'))}" aria-label="${esc(t('lp.codePh'))}" autocomplete="off" spellcheck="false">
    <button type="button" class="btn small" data-lp-add>${t('lp.add')}</button>
  </div>
  <small class="lp-err" role="alert"></small>`;

/**
 * Выбор языков перевода: чипы «самоназвание + код» с ×, список частых языков и поле для своего кода.
 * Значение лежит в скрытом поле name="…" через запятую — формы читают его как раньше (parseLangs).
 */
function langPicker(name, langs, sourceLang = '') {
  return `<div class="lang-picker" data-lp data-source="${esc(sourceLang)}">
    <input type="hidden" name="${esc(name)}" value="${esc(langs.join(', '))}">
    <div class="chips"></div>
    ${langAddBox(langs, sourceLang, '')}
  </div>`;
}

function lpState(lp) {
  const hidden = lp.querySelector('input[type=hidden]');
  // В форме новой игры язык оригинала редактируется — берём текущее значение поля
  const source = lp.closest('form')?.elements.sourceLang?.value.trim() || lp.dataset.source || '';
  return { hidden, langs: parseLangs(hidden.value), source };
}

function lpRender(lp) {
  const { langs, source } = lpState(lp);
  lp.querySelector('.chips').innerHTML = langs.length
    ? langs
        .map((l) => `<span class="chip"><b>${esc(langName(l))}</b><span class="mono">${esc(l)}</span><button type="button" data-lp-remove="${esc(l)}" title="${esc(t('lp.remove', { lang: langName(l) }))}" aria-label="${esc(t('lp.remove', { lang: langName(l) }))}">×</button></span>`)
        .join('')
    : `<span class="muted">${t('lp.none')}</span>`;
  lp.querySelector('[data-lp-select]').innerHTML = langAddOptions(langs, source);
}

function lpAdd(lp, code) {
  const { hidden, langs, source } = lpState(lp);
  const err = langCodeError(code, langs, source);
  lp.querySelector('.lp-err').textContent = err;
  if (err) return false;
  hidden.value = [...langs, code].join(', ');
  lpRender(lp);
  return true;
}

/** Код из поля ввода или из списка; '' если ничего не выбрано. */
function lpPicked(box) {
  const input = box.querySelector('[data-lp-code]');
  return input.value.trim() || box.querySelector('[data-lp-select]').value;
}

// Обработчики выбора языков (и в формах, и на странице игры)
document.addEventListener('click', (e) => {
  const rm = e.target.closest('[data-lp-remove]');
  if (rm) {
    const lp = rm.closest('[data-lp]');
    const { hidden, langs } = lpState(lp);
    hidden.value = langs.filter((l) => l !== rm.dataset.lpRemove).join(', ');
    lpRender(lp);
    return;
  }
  const add = e.target.closest('[data-lp-add]');
  if (!add) return;
  const box = add.closest('.lp-add');
  const code = lpPicked(box);
  if (!code) return;
  if (box.hasAttribute('data-ov-add')) return overviewAddLang(box, code);
  if (lpAdd(box.closest('[data-lp]'), code)) box.querySelector('[data-lp-code]').value = '';
});
document.addEventListener('change', (e) => {
  const sel = e.target.closest?.('[data-lp-select]');
  if (!sel || !sel.value) return;
  const box = sel.closest('.lp-add');
  if (box.hasAttribute('data-ov-add')) return; // на странице игры добавляем кнопкой — это сохранение
  lpAdd(box.closest('[data-lp]'), sel.value);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches?.('[data-lp-code]')) return;
  e.preventDefault(); // не отправлять форму
  e.target.closest('.lp-add').querySelector('[data-lp-add]').click();
});
// Рисуем чипы, когда пикер появился на странице
new MutationObserver(() => document.querySelectorAll('[data-lp]:not([data-ready])').forEach((lp) => { lp.dataset.ready = '1'; lpRender(lp); })).observe(view, { childList: true, subtree: true });

// ---------- страница-обзор игры ----------

let overview = null; // { slug, game, stats }

async function renderOverview(slug) {
  const { game, stats, canManage, status, moderates, formats: extFormats } = await api(`/games/${encodeURIComponent(slug)}`);
  const fmtList = await loadFormats().catch(() => []);
  const credits = Object.fromEntries(
    await Promise.all(game.languages.map(async (l) => [l, await api(`/games/${encodeURIComponent(slug)}/credits?lang=${encodeURIComponent(l)}`).catch(() => null)])),
  );
  overview = { slug, game, stats };
  docTitle(game.title);
  crumbs.innerHTML = `${gamesCrumb()} / ${esc(game.title)}`;
  const gh = game.repo ? `https://github.com/${game.repo}` : null;
  const linkBtn = (l) => `<a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener nofollow">${esc(l.title || t('link.' + l.kind))} ↗</a>`;

  const rows = game.languages
    .map((l) => {
      const st = stats.find((x) => x.lang === l) || { approved: 0, voting: 0, total: 0 };
      const p = pct(st.approved, st.total);
      return `<div class="ov-lang" data-lang="${esc(l)}" data-rev-host>
        <span class="ov-name"><a href="${href(slug, l)}"><b>${esc(langName(l))}</b> <span class="muted mono">${esc(l)}</span></a>${
          canManage
            ? `<small class="enc-label mono muted" title="${esc(t('enc.output', { enc: game.encodings?.[l] || game.source_encoding || 'utf-8' }))}">${esc(game.encodings?.[l] || game.source_encoding || 'utf-8')}${game.encodings?.[l] ? '' : ` · ${t('enc.asSourceShort')}`}</small>`
            : ''
        }</span>
        <span class="ov-progress"><span class="bar"><i style="width:${p}%"></i></span><span class="pct">${p}%</span></span>
        <span class="ov-count muted">${st.approved}/${st.total}${st.voting ? ` <span class="vcount" title="${esc(t('ov.withVariants', { n: st.voting }))}">+${st.voting}</span>` : ''}</span>
        <span class="ov-stage">${stageChip(status?.[l]?.status)}<small class="rev-label">${t('rev.label', { n: status?.[l]?.revision ?? 1 })}</small></span>
        <span class="ov-actions">
          <a class="btn small primary" href="${href(slug, l)}">${t('ov.translate')}</a>
          ${gh ? `<a class="btn small" href="${esc(gh)}/releases?q=${encodeURIComponent(l + '-')}&expanded=true" target="_blank" rel="noopener" title="${esc(t('ov.downloadTitle', { lang: langName(l) }))}">${t('ov.download')}</a>` : ''}
          ${canManage && game.repo ? `<a class="btn small" href="#/g/${encodeURIComponent(slug)}/settings?publish=${encodeURIComponent(l)}" title="${esc(t('pub.publishLangTitle', { lang: langName(l) }))}">${t('pub.publishLang')}</a>` : ''}
          ${moderates?.[l] && !snapshot.on ? revisionButton(slug, l, st.approved + (st.stale ?? 0), status?.[l]?.status || 'open') : ''}
          ${canManage ? `<button type="button" class="link" data-ov-remove="${esc(l)}" title="${esc(t('lp.remove', { lang: langName(l) }))}">×</button>` : ''}
        </span>
        <div class="ov-confirm" hidden></div>
        <div class="rev-box" hidden></div>
      </div>`;
    })
    .join('');

  const creditRows = game.languages
    .map((l) => {
      const c = credits[l];
      if (!c?.translators?.length) return '';
      const top = c.translators.slice(0, 8).map((x) => `${esc(x.login)} <span class="muted">${x.strings}</span>`).join(', ');
      return `<li><b>${esc(langName(l))}</b> — ${top}${c.translators.length > 8 ? ' …' : ''}</li>`;
    })
    .join('');

  view.innerHTML = `
    <section class="panel game-hero">
      ${coverImg(game, 'hero-cover')}
      <div class="hero-body">
        <h1>${esc(game.title)}</h1>
        <p class="muted">${t('ov.source', { lang: esc(langName(game.source_lang)) })} · ${t('home.strings', { n: stats[0]?.total ?? 0 })}</p>
        ${formatsLine(extFormats, fmtList)}
        ${game.description ? `<p class="hero-desc">${esc(game.description)}</p>` : ''}
        <div class="actions">
          ${(game.links || []).map(linkBtn).join('')}
          ${gh ? `<a class="btn" href="${esc(gh)}" target="_blank" rel="noopener">${t('ov.github')}</a><a class="btn primary" href="${esc(gh)}/releases" target="_blank" rel="noopener">${t('ov.releases')}</a>` : ''}
          ${canManage ? `<a class="btn" href="#/g/${encodeURIComponent(slug)}/settings">${t('game.settings')}</a>` : ''}
        </div>
      </div>
    </section>
    <section class="panel ov-langs">
      <h2>${t('ov.languages')}</h2>
      ${rows || `<p class="muted">${t('ov.noLanguages')}</p>`}
      ${canManage ? `<div class="ov-addlang"><span class="field-label">${t('ov.addLang')}</span>${langAddBox(game.languages, game.source_lang, 'data-ov-add')}</div>` : ''}
    </section>
    <section class="panel">
      <h2>${t('ov.credits')}</h2>
      ${creditRows ? `<ul class="ov-credits">${creditRows}</ul>` : `<p class="muted">${t('ov.noCredits')}</p>`}
    </section>`;
}

/** Тихая строка «.xml → RimWorld · .gpc → Gunpoint · .png — как есть» на странице игры. */
function formatsLine(exts = [], list = []) {
  const used = exts.filter((x) => x.ext && x.format && x.format !== RAW);
  const raw = exts.filter((x) => x.ext && x.format === RAW).map((x) => x.ext);
  if (!used.length && !raw.length) return '';
  const parts = used.map((x) => `<span class="mono">${esc(x.ext)}</span> → ${esc(formatTitle(list, x.format))}`);
  if (raw.length) parts.push(`<span class="mono">${esc(raw.join(', '))}</span> — ${esc(t('fmap.rawShort'))}`);
  return `<p class="muted ov-formats" title="${esc(t('fmap.title'))}">${parts.join(' · ')}</p>`;
}

async function saveLanguages(languages, force = false) {
  await api(`/games/${encodeURIComponent(overview.slug)}/settings`, { method: 'POST', body: { languages, force } });
}

async function overviewAddLang(box, code) {
  const err = langCodeError(code, overview.game.languages, overview.game.source_lang);
  const errBox = box.parentElement.querySelector('.lp-err');
  errBox.textContent = err;
  if (err) return;
  try {
    await saveLanguages([...overview.game.languages, code]);
    toast(t('ov.langAdded', { lang: langName(code) }));
    await route();
  } catch (e) {
    errBox.textContent = e.message;
  }
}

// Убрать язык: подтверждение прямо в строке (с числом утверждённых строк и вариантов)
document.addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-ov-remove]');
  if (rm && overview) {
    const l = rm.dataset.ovRemove;
    const st = overview.stats.find((x) => x.lang === l) || { approved: 0, voting: 0 };
    const box = rm.closest('.ov-lang').querySelector('.ov-confirm');
    box.hidden = false;
    box.innerHTML = `<span>${t('ov.removeConfirm', { lang: esc(langName(l)), approved: st.approved, voting: st.voting })}</span>
      <button type="button" class="btn small bad" data-ov-remove-yes="${esc(l)}">${t('ov.removeYes')}</button>
      <button type="button" class="btn small" data-ov-remove-no>${t('common.cancel')}</button>`;
    return;
  }
  if (e.target.closest('[data-ov-remove-no]')) {
    const box = e.target.closest('.ov-confirm');
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const yes = e.target.closest('[data-ov-remove-yes]');
  if (yes && overview) {
    const l = yes.dataset.ovRemoveYes;
    try {
      await saveLanguages(overview.game.languages.filter((x) => x !== l), true);
      toast(t('ov.langRemoved', { lang: langName(l) }));
      await route();
    } catch (err) {
      toast(err.message);
    }
  }
});
