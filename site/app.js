// LocalizationForum — клиент. Без сборки: обычный ES-модуль.
import { LOCALES, detectLocale, getLocale, setLocale, t } from './i18n.js';

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
const LANG_NAMES = { ru: 'Русский', uk: 'Українська', be: 'Беларуская', kk: 'Қазақша', en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', pl: 'Polski' };
const langName = (l) => LANG_NAMES[l] || l;
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

async function api(path, { method = 'GET', body } = {}) {
  // Accept-Language — на будущее: сервер пока отвечает по-русски
  const headers = { 'Accept-Language': getLocale() };
  const token = store.get('token');
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error(t('app.offline')), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { store.set('token', null); me = null; renderAccount(); }
  if (!res.ok) throw Object.assign(new Error(data.error || t('app.error', { status: res.status })), { status: res.status, data });
  return data;
}

function login() {
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
  account.innerHTML = `
    ${me
      ? `${me.avatar_url ? `<img class="avatar" src="${esc(me.avatar_url)}&s=52" alt="">` : ''}<span>${esc(me.login)}</span>`
      : `<button class="btn small primary" data-act="login">${t('account.login')}</button>`}
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
  const head = `<div class="page-head"><h1>${t('home.title')}</h1><span class="spacer"></span><a class="btn" href="#/formats">${t('home.formats')}</a>${me ? `<a class="btn primary" href="#/new">${t('home.newGame')}</a>` : `<button class="btn" data-act="login">${t('home.loginToAdd')}</button>`}</div>`;
  if (!games.length) {
    view.innerHTML = head + `<div class="empty">${t('home.empty')}${me ? ' ' + t('home.emptyAdd') : ''}</div>`;
    return;
  }
  view.innerHTML = head + `<div class="games">${games
    .map(
      (g) => `
      <section class="card">
        <h2>${esc(g.title)}</h2>
        <div class="muted">${t('home.strings', { n: g.total })} · ${esc(g.format)}${g.repo ? ` · <a href="https://github.com/${esc(g.repo)}" target="_blank" rel="noopener">${esc(g.repo)}</a>` : ''}</div>
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
    location.replace(href(slug, game.languages[0]));
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
  if (ban) can.propose = can.vote = can.approve = false;
  state = { slug, lang, game, data, params, files: files.files, stage, can, ban, canManage };
  const st = stats.find((s) => s.lang === lang) || { approved: 0, stale: 0, voting: 0, total: 0 };
  state.st = st;

  docTitle(`${game.title} — ${langName(lang)}`);
  crumbs.innerHTML = `${gamesCrumb()} / ${esc(game.title)} / ${esc(langName(lang))}`;

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
          ${st.approved ? `<button class="btn small" data-act="download" data-slug="${esc(slug)}" data-lang="${esc(lang)}">${t('game.download')}</button>` : ''}
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
  return `<div class="stage-banner ${cur}">${stageChip(cur)}<span class="muted">${esc(desc)}${when}</span>${ctl}</div>`;
}

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
    ? `<div class="approved ${s.stale ? 'stale' : ''}">${s.stale ? `<span class="badge">${t('str.sourceChanged')}</span>` : ''}<div class="atext">${esc(s.approved_text)}</div><span class="meta">${t('str.approved')}${s.approved_by ? ` · ${esc(s.approved_by)}` : ''}${chosenVariant ? ` · ${t('str.author', { name: esc(chosenVariant.author || t('str.anon')) })}${chosenVariant.ai ? aiBadge() : ''}${chosenVariant.votes ? ` · ▲ ${chosenVariant.votes}` : ''}` : ''}${mod ? ` · <button class="link" data-act="unapprove" data-id="${s.id}">${t('str.unapprove')}</button>` : ''}</span></div>`
    : '';
  const variants = s.variants
    .filter((v) => v !== chosenVariant)
    .map((v) => {
      const canDelete = me && state.stage !== 'done' && ((v.author === me.login && canPropose) || mod);
      return `<li class="variant">
        <button class="vote ${v.mine ? 'mine' : ''}" data-act="vote" data-id="${v.id}" data-mine="${v.mine ? 1 : 0}" title="${esc(voteTitle(v))}" ${canVote ? '' : 'disabled'}>▲<span>${v.votes}</span></button>
        <div><div class="vtext">${esc(v.text)}</div><div class="vmeta">${esc(v.author || t('str.anon'))}${v.ai ? aiBadge() : ''}${banLink(v.author)}</div></div>
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

const slugify = (s) =>
  s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

const parseLangs = (v) => v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

async function renderNewGame() {
  crumbs.innerHTML = `${gamesCrumb()} / ${t('new.title')}`;
  docTitle(t('new.title'));
  if (!me) {
    view.innerHTML = `<div class="empty">${t('new.loginPrompt', { button: `<button class="btn primary" data-act="login">${t('new.loginButton')}</button>` })}</div>`;
    return;
  }
  const formats = await loadFormats(true);
  view.innerHTML = `
    <form class="panel form" data-form="new-game">
      <h1>${t('new.title')}</h1>
      <label>${t('new.name')}<input name="title" required maxlength="200" placeholder="RimWorld" autocomplete="off"></label>
      <label>${t('new.slug')}<input name="slug" required pattern="[a-z0-9][a-z0-9\\-]{0,62}" placeholder="rimworld" autocomplete="off">
        <small>${t('new.slugHint')}</small></label>
      <label>${t('new.format')}<select name="format">${formatOptions(formats, 'rimworld')}</select>
        <small>${t('new.formatHint')}</small></label>
      <div class="row2">
        <label>${t('new.sourceLang')}<input name="sourceLang" value="en" required></label>
        <label>${t('new.languages')}<input name="languages" value="ru" required placeholder="ru, uk"><small>${t('new.languagesHint')}</small></label>
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
          format: f.format.value,
          sourceLang: f.sourceLang.value.trim(),
          languages: parseLangs(f.languages.value),
          repo: f.repo.value,
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
  const [data, { bans }] = await Promise.all([api(`/games/${encodeURIComponent(slug)}/manage`), api(`/games/${encodeURIComponent(slug)}/bans`)]);
  const { game, moderators, files, strings } = data;
  const banDate = (d) => esc(new Date(d).toLocaleString(getLocale()));
  const formats = await loadFormats(true);
  const fmt = fmtInfo(formats, game.format);
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
          <label>${t('new.languages')}<input name="languages" value="${esc(game.languages.join(', '))}" required>
            <small>${t('set.languagesHint')}</small></label>
          <label>${t('set.repo')}<input name="repo" value="${esc(game.repo || '')}" placeholder="owner/name"></label>
        </div>
        ${strings ? `<p class="muted">${t('set.formatIs', { name: esc(fmt.name) })}</p>` : `<label>${t('new.format')}<select name="format">${formatOptions(formats, game.format)}</select><small>${t('set.formatHint')}</small></label>`}
        <p class="muted">${t('set.address', { slug: `<span class="mono">${esc(game.slug)}</span>`, lang: esc(game.source_lang) })}</p>
        <div class="actions"><button class="btn primary">${t('common.save')}</button></div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="source">
        <h2>${t('set.source')}</h2>
        <p class="muted">${t('set.sourceNow', { files: `<b data-count="files">${files}</b>`, strings: `<b data-count="strings">${strings}</b>` })} ${esc(fmt.hint)}</p>
        ${filePicker(fmt)}
        <label class="check"><input type="checkbox" name="replace"> ${t('set.replace')}</label>
        <div class="actions"><button class="btn primary">${t('set.upload')}</button>${files ? `<button type="button" class="btn" data-reparse title="${esc(t('set.reparseTitle'))}">${t('set.reparse')}</button>` : ''}</div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="translation">
        <h2>${t('set.import')}</h2>
        <p class="muted">${t('set.importHelp')}</p>
        <label>${t('set.lang')}<select name="lang">${langOptions(false)}</select></label>
        ${filePicker(fmt)}
        <label class="check"><input type="checkbox" name="overwrite"> ${t('set.overwrite')}</label>
        <div class="actions"><button class="btn primary">${t('set.importBtn')}</button></div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form accent" data-form="publish">
        <h2>${t('set.publish')}</h2>
        ${publishResult(q.get('pub'))}
        <p class="muted">${t('set.publishHelp', { repo: game.repo ? esc(game.repo) : t('set.publishRepoFallback') })}</p>
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

  // Формат сохраняется сразу при выборе: от него зависит, какие файлы примет загрузка ниже.
  forms.settings.format?.addEventListener('change', async (e) => {
    try {
      await api(`/games/${encodeURIComponent(slug)}/settings`, { method: 'POST', body: { format: e.target.value } });
      toast(t('set.formatSaved'));
      renderSettings(slug);
    } catch (err) {
      report(forms.settings, [['error', err.message]]);
    }
  });

  onSubmit('settings', async (f) => {
    await api(`/games/${encodeURIComponent(slug)}/settings`, {
      method: 'POST',
      body: { title: f.title.value, languages: parseLangs(f.languages.value), repo: f.repo.value, format: f.format?.value },
    });
    toast(t('common.saved'));
    renderSettings(slug);
  });

  onSubmit('source', async (f) => {
    const files = await collectFiles(f, fmt);
    if (!files.length) throw new Error(t('set.noFiles', { ext: fmt.ext.join(', ') }));
    const total = { added: 0, changed: 0, removed: 0, unchanged: 0 };
    const errors = [];
    const parts = batches(files);
    for (let i = 0; i < parts.length; i++) {
      report(f, [['warn', t('set.uploading', { i: i + 1, n: parts.length })]]);
      const last = i === parts.length - 1;
      const r = await api(`/games/${encodeURIComponent(slug)}/source`, {
        method: 'POST',
        body: { files: parts[i], paths: last && f.replace.checked ? files.map((x) => x.path) : undefined },
      });
      for (const k of Object.keys(total)) total[k] += r[k];
      errors.push(...r.errors);
    }
    report(f, [
      ['ok', t('set.uploadDone', total)],
      ...errors.map((e) => ['error', e]),
    ]);
    toast(t('set.sourceUploaded'));
    const fresh = await api(`/games/${encodeURIComponent(slug)}/manage`);
    f.querySelector('[data-count=files]').textContent = fresh.files;
    f.querySelector('[data-count=strings]').textContent = fresh.strings;
  });

  forms.source.querySelector('[data-reparse]')?.addEventListener('click', async () => {
    const f = forms.source;
    busy(f, true);
    try {
      const r = await api(`/games/${encodeURIComponent(slug)}/reparse`, { method: 'POST' });
      report(f, [['ok', t('set.reparsed', r)]]);
      const fresh = await api(`/games/${encodeURIComponent(slug)}/manage`);
      f.querySelector('[data-count=strings]').textContent = fresh.strings;
    } catch (err) {
      report(f, [['error', err.message]]);
    } finally {
      busy(f, false);
    }
  });

  onSubmit('translation', async (f) => {
    const files = await collectFiles(f, fmt);
    if (!files.length) throw new Error(t('set.noFiles', { ext: fmt.ext.join(', ') }));
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
    const r = await api(`/games/${encodeURIComponent(slug)}/publish/start`, {
      method: 'POST',
      body: { version: f.version.value.trim(), return: location.origin + location.pathname },
    });
    report(f, [['warn', t('set.toGithub')]]);
    location.href = r.url;
  });
  if (q.get('pub')) forms.publish.scrollIntoView({ block: 'center' });

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

function filePicker(fmt) {
  return `
    <div class="picker">
      <label class="btn small">${t('pick.files')}<input type="file" name="files" multiple accept="${fmt.ext.join(',')}" hidden></label>
      <label class="btn small">${t('pick.folder')}<input type="file" name="folder" webkitdirectory hidden></label>
      <span class="muted picked">${t('pick.none')}</span>
    </div>
    <label>${t('pick.prefix')}<input name="prefix" placeholder="${esc(fmt.ext.includes('.xml') ? 'Core/Keyed' : t('pick.prefixPh'))}">
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

async function collectFiles(form, fmt) {
  const prefix = form.prefix.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const out = [];
  const add = async (file, rel) => {
    if (fmt.ext.length && !fmt.ext.some((x) => file.name.toLowerCase().endsWith(x))) return;
    const path = [prefix, rel].filter(Boolean).join('/');
    out.push({ path, content: await file.text() });
  };
  for (const f of form.files.files) await add(f, f.name);
  for (const f of form.folder.files) await add(f, (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name);
  return out;
}

function batches(files, limit = 3_000_000) {
  const out = [[]];
  let size = 0;
  for (const f of files) {
    const s = new Blob([f.content]).size + f.path.length + 32;
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
    const data = enc.encode(f.content);
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
      const r = await api(`/games/${encodeURIComponent(slug)}/export?lang=${encodeURIComponent(lang)}`);
      if (!r.files.length) return toast(t('dl.none'));
      const url = URL.createObjectURL(makeZip(r.files.map((f) => ({ path: `${lang}/${f.path}`, content: f.content }))));
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
    ...(r.releases || []).map((tag) => t('pub.release', { link: link(`${r.url}/releases/tag/${tag}`, tag) })),
  ];
  return `<ul class="issues"><li class="ok">${t('pub.done')} ${parts.join(' ')}</li></ul>`;
}

// ---------- токены и подключение MCP ----------
async function renderTokens() {
  crumbs.innerHTML = `${gamesCrumb()} / ${t('tok.title')}`;
  docTitle(t('tok.title'));
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
