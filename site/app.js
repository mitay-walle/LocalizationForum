// LocalizationForum — клиент. Без сборки: обычный ES-модуль.
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
const LANG_NAMES = { ru: 'Русский', uk: 'Українська', be: 'Беларуская', kk: 'Қазақша', en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', pl: 'Polski' };
const langName = (l) => LANG_NAMES[l] || l;

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2800);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = store.get('token');
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('Сервер недоступен. Чтение может работать, а голосование — нет.'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { store.set('token', null); me = null; renderAccount(); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Ошибка ${res.status}`), { status: res.status, data });
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

function renderAccount() {
  if (me) {
    account.innerHTML = `
      ${me.avatar_url ? `<img class="avatar" src="${esc(me.avatar_url)}&s=52" alt="">` : ''}
      <span>${esc(me.login)}</span>
      <button class="btn small" data-act="logout">Выйти</button>`;
  } else {
    account.innerHTML = `<button class="btn small primary" data-act="login">Войти через GitHub</button>`;
  }
}

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
    if (parts[0] === 'g' && parts[1]) await renderGame(parts[1], parts[2], q);
    else await renderHome();
  } catch (e) {
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---------- главная ----------
async function renderHome() {
  crumbs.innerHTML = '';
  document.title = 'LocalizationForum';
  const { games } = await api('/games');
  if (!games.length) {
    view.innerHTML = `<div class="empty">Пока нет ни одной игры. Игры добавляются из своих репозиториев (см. README).</div>`;
    return;
  }
  view.innerHTML = `<div class="games">${games
    .map(
      (g) => `
      <section class="card">
        <h2>${esc(g.title)}</h2>
        <div class="muted">${g.total} строк · ${esc(g.format)}${g.repo ? ` · <a href="https://github.com/${esc(g.repo)}" target="_blank" rel="noopener">${esc(g.repo)}</a>` : ''}</div>
        <div class="langs">${g.languages
          .map((l) => {
            const p = pct(g.approved[l] || 0, g.total);
            return `<a class="lang-row" href="${href(g.slug, l)}"><b>${esc(l)}</b><span class="bar"><i style="width:${p}%"></i></span><span class="pct">${p}%</span></a>`;
          })
          .join('')}</div>
        ${g.repo ? `<div style="margin-top:10px"><a href="https://github.com/${esc(g.repo)}/releases" target="_blank" rel="noopener">Скачать релизы перевода →</a></div>` : ''}
      </section>`,
    )
    .join('')}</div>`;
}

// ---------- страница перевода ----------
const FILTERS = [
  ['all', 'Все'],
  ['untranslated', 'Без перевода'],
  ['voting', 'Есть варианты'],
  ['approved', 'Утверждено'],
  ['stale', 'Устарело'],
];

let state = null; // { slug, lang, game, data, params }

async function renderGame(slug, lang, q) {
  const { game, stats } = await api(`/games/${encodeURIComponent(slug)}`);
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
  state = { slug, lang, game, data, params };
  const st = stats.find((s) => s.lang === lang) || { approved: 0, stale: 0, voting: 0, total: 0 };

  document.title = `${game.title} — ${langName(lang)} · LocalizationForum`;
  crumbs.innerHTML = `<a href="#/">Игры</a> / ${esc(game.title)} / ${esc(langName(lang))}`;

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  view.innerHTML = `
    <div class="layout">
      <aside class="side">
        <a href="${href(slug, lang, { ...params, file: '', page: 1 })}" class="${params.file ? '' : 'on'}">Все файлы <small>${st.total}</small></a>
        ${files.files
          .map((f) => `<a href="${href(slug, lang, { ...params, file: f.file, page: 1 })}" class="${f.file === params.file ? 'on' : ''}" title="${esc(f.file)}">${esc(f.file)} <small>${f.approved}/${f.total}</small></a>`)
          .join('')}
      </aside>
      <section>
        <div class="stats">
          <span>Переведено <b>${pct(st.approved, st.total)}%</b></span>
          <span>Утверждено <b>${st.approved}</b></span>
          <span>На голосовании <b>${st.voting}</b></span>
          <span>Устарело <b>${st.stale}</b></span>
          <span>Всего <b>${st.total}</b></span>
          ${game.languages.length > 1 ? `<span>Язык: <select data-act="lang">${game.languages.map((l) => `<option value="${esc(l)}" ${l === lang ? 'selected' : ''}>${esc(langName(l))}</option>`).join('')}</select></span>` : ''}
        </div>
        <div class="toolbar">
          <nav class="tabs">${FILTERS.map(([id, name]) => `<a href="${href(slug, lang, { ...params, filter: id, page: 1 })}" class="${params.filter === id ? 'on' : ''}">${name}</a>`).join('')}</nav>
          <input class="search" type="search" placeholder="Поиск по ключу, оригиналу или переводу" value="${esc(params.q)}" data-act="search">
        </div>
        ${data.strings.length ? data.strings.map(renderString).join('') : `<div class="empty">Ничего не найдено</div>`}
        ${pages > 1 ? `<div class="pager">
          ${params.page > 1 ? `<a class="btn" href="${href(slug, lang, { ...params, page: params.page - 1 })}">← Назад</a>` : ''}
          <span class="muted">${params.page} / ${pages}</span>
          ${params.page < pages ? `<a class="btn" href="${href(slug, lang, { ...params, page: params.page + 1 })}">Дальше →</a>` : ''}
        </div>` : ''}
      </section>
    </div>`;
}

function renderString(s) {
  const mod = state.data.canModerate;
  const approved = s.approved_text != null
    ? `<div class="approved ${s.stale ? 'stale' : ''}">${s.stale ? '<span class="badge">оригинал изменился</span>' : ''}<div class="atext">${esc(s.approved_text)}</div><span class="meta">утверждено${s.approved_by ? ` · ${esc(s.approved_by)}` : ''}${mod ? ` · <button class="link" data-act="unapprove" data-id="${s.id}">снять</button>` : ''}</span></div>`
    : '';
  const variants = s.variants
    .map((v) => {
      const chosen = s.approved_variant === v.id && !s.stale;
      const canDelete = me && (v.author === me.login || mod);
      return `<li class="variant">
        <button class="vote ${v.mine ? 'mine' : ''}" data-act="vote" data-id="${v.id}" data-mine="${v.mine ? 1 : 0}" title="${v.mine ? 'Убрать голос' : 'Голосовать'}">▲<span>${v.votes}</span></button>
        <div><div class="vtext ${chosen ? 'chosen' : ''}">${esc(v.text)}</div><div class="vmeta">${esc(v.author || 'аноним')}</div></div>
        <div class="vactions">
          ${mod && !chosen ? `<button class="btn small" data-act="approve" data-id="${s.id}" data-variant="${v.id}">Утвердить</button>` : ''}
          ${canDelete ? `<button class="link" data-act="delete" data-id="${v.id}" title="Удалить вариант">удалить</button>` : ''}
        </div>
      </li>`;
    })
    .join('');
  return `<article class="str" data-string="${s.id}">
    <div class="str-head"><span class="mono">${esc(s.key)}</span>${state.params.file ? '' : `<span class="mono">${esc(s.file)}</span>`}</div>
    <div class="source">${esc(s.source)}</div>
    ${s.context ? `<div class="context">${esc(s.context)}</div>` : ''}
    ${approved}
    ${variants ? `<ul class="variants">${variants}</ul>` : ''}
    <div class="propose">
      <textarea rows="1" placeholder="${me ? 'Ваш вариант перевода' : 'Войдите, чтобы предложить вариант'}" data-act="draft" data-id="${s.id}" ${me ? '' : 'disabled'}></textarea>
      <div class="propose-row" hidden>
        <button class="btn primary small" data-act="propose" data-id="${s.id}">Предложить</button>
        ${mod ? `<button class="btn small" data-act="approve-text" data-id="${s.id}">Утвердить этот текст</button>` : ''}
        <button class="link" data-act="copy-source" data-id="${s.id}">вставить оригинал</button>
      </div>
      <ul class="issues"></ul>
    </div>
  </article>`;
}

function showIssues(card, issues) {
  card.querySelector('.issues').innerHTML = (issues || []).map((i) => `<li class="${i.level}">${esc(i.message)}</li>`).join('');
}

// ---------- действия ----------
const lang = () => state?.lang;

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'login') return login();
  if (act === 'logout') return logout();
  if (['vote', 'propose', 'approve', 'approve-text', 'unapprove', 'delete', 'copy-source'].includes(act) && !me) return login();
  const card = el.closest('[data-string]');
  try {
    if (act === 'vote') {
      const mine = el.dataset.mine === '1';
      const r = await api(`/variants/${el.dataset.id}/vote`, { method: mine ? 'DELETE' : 'POST' });
      el.classList.toggle('mine', r.mine);
      el.dataset.mine = r.mine ? '1' : '0';
      el.querySelector('span').textContent = r.votes;
    } else if (act === 'propose') {
      const text = card.querySelector('textarea').value;
      const r = await api(`/strings/${el.dataset.id}/variants`, { method: 'POST', body: { lang: lang(), text } });
      toast(r.issues?.length ? 'Вариант добавлен, но есть замечания' : 'Вариант добавлен');
      await refreshCard(card);
    } else if (act === 'approve') {
      await api(`/strings/${el.dataset.id}/approve`, { method: 'POST', body: { lang: lang(), variantId: Number(el.dataset.variant) } });
      toast('Утверждено');
      await refreshCard(card);
    } else if (act === 'approve-text') {
      const text = card.querySelector('textarea').value;
      await api(`/strings/${el.dataset.id}/approve`, { method: 'POST', body: { lang: lang(), text } });
      toast('Утверждено');
      await refreshCard(card);
    } else if (act === 'unapprove') {
      await api(`/strings/${el.dataset.id}/approve?lang=${encodeURIComponent(lang())}`, { method: 'DELETE' });
      toast('Утверждение снято');
      await refreshCard(card);
    } else if (act === 'delete') {
      await api(`/variants/${el.dataset.id}`, { method: 'DELETE' });
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
  if (e.target.matches?.('textarea[data-act="draft"]') && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    e.target.closest('[data-string]').querySelector('[data-act="propose"]').click();
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

await loadMe();
renderAccount();
route();
