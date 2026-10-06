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

// ---------- уведомления и отмена последнего действия ----------
const undoStack = []; // { label, run }

function toast(msg, undo) {
  const t = document.getElementById('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button class="toast-undo" data-act="undo">Отменить <kbd>Ctrl+Z</kbd></button>` : ''}`;
  if (undo) {
    undoStack.push(undo);
    if (undoStack.length > 30) undoStack.shift();
  }
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), undo ? 6000 : 2800);
}

async function undoLast() {
  const u = undoStack.pop();
  if (!u) return toast('Нечего отменять');
  try {
    await u.run();
    toast(`Отменено: ${u.label}`);
  } catch (err) {
    toast(`Не удалось отменить: ${err.message}`);
  }
}

/** Перерисовать строку по id, если она на экране. */
async function refreshById(id) {
  const card = document.querySelector(`[data-string="${id}"]`);
  if (card) await refreshCard(card);
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
  account.innerHTML = `
    ${me
      ? `${me.avatar_url ? `<img class="avatar" src="${esc(me.avatar_url)}&s=52" alt="">` : ''}<span>${esc(me.login)}</span>`
      : `<button class="btn small primary" data-act="login">Войти через GitHub</button>`}
    <button class="icon-btn" data-act="ui-menu" title="Настройки интерфейса" aria-label="Настройки интерфейса">⚙</button>
    <div class="ui-menu" hidden>
      <h3>Тема</h3>
      <div class="seg" data-ui="theme">
        <button data-v="auto">Как в системе</button><button data-v="light">Светлая</button><button data-v="dark">Тёмная</button>
      </div>
      <h3>Размер текста</h3>
      <div class="range-row"><span class="muted">A</span><input type="range" min="13" max="21" step="1" data-ui="size"><span style="font-size:1.3rem">A</span><b data-ui="size-val"></b></div>
      <h3>Отмена действий</h3>
      <p class="muted" style="margin:0;font-size:.87rem">Голоса, варианты и утверждения можно отменить кнопкой в уведомлении или <kbd>Ctrl+Z</kbd>.</p>
      ${me ? `<a href="#/tokens">Токены и подключение MCP →</a><button class="btn small" data-act="logout">Выйти</button>` : ''}
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

// ---------- главная ----------
async function renderHome() {
  crumbs.innerHTML = '';
  document.title = 'LocalizationForum';
  const { games } = await api('/games');
  const head = `<div class="page-head"><h1>Игры</h1><span class="spacer"></span><a class="btn" href="#/formats">Форматы файлов</a>${me ? `<a class="btn primary" href="#/new">+ Новая игра</a>` : `<button class="btn" data-act="login">Войдите, чтобы добавить игру</button>`}</div>`;
  if (!games.length) {
    view.innerHTML = head + `<div class="empty">Пока нет ни одной игры.${me ? ' Добавьте первую — кнопка выше.' : ''}</div>`;
    return;
  }
  view.innerHTML = head + `<div class="games">${games
    .map(
      (g) => `
      <section class="card">
        <h2>${esc(g.title)}</h2>
        <div class="muted">${g.total} строк · ${esc(g.format)}${g.repo ? ` · <a href="https://github.com/${esc(g.repo)}" target="_blank" rel="noopener">${esc(g.repo)}</a>` : ''}</div>
        <div class="langs">${g.languages
          .map((l) => {
            const p = pct(g.approved[l] || 0, g.total);
            return `<a class="lang-row" href="${href(g.slug, l)}"><b>${esc(l)}</b><span class="bar"><i style="width:${p}%"></i></span><span class="pct">${p}%</span>${stageChip(g.status?.[l])}</a>`;
          })
          .join('')}</div>
        ${g.repo ? `<div style="margin-top:10px"><a href="https://github.com/${esc(g.repo)}/releases" target="_blank" rel="noopener">Скачать релизы перевода →</a></div>` : ''}
      </section>`,
    )
    .join('')}</div>`;
}

// ---------- этапы перевода языка ----------
const STAGES = [
  ['open', 'Групповой перевод', 'Все предлагают варианты и голосуют'],
  ['review', 'Апрув', 'Модераторы проверяют и утверждают; предлагать и голосовать могут только модераторы'],
  ['done', 'Готово', 'Перевод завершён и закрыт для изменений'],
];
const stageInfo = (id) => STAGES.find((x) => x[0] === id) || STAGES[0];
const stageChip = (id) => { const [k, t, d] = stageInfo(id); return `<span class="stage ${k}" title="${esc(d)}">${t}</span>`; };

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
  const { game, stats, canManage, status, moderates } = await api(`/games/${encodeURIComponent(slug)}`);
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
  state = { slug, lang, game, data, params, files: files.files, stage, can };
  const st = stats.find((s) => s.lang === lang) || { approved: 0, stale: 0, voting: 0, total: 0 };
  state.st = st;

  document.title = `${game.title} — ${langName(lang)} · LocalizationForum`;
  crumbs.innerHTML = `<a href="#/">Игры</a> / ${esc(game.title)} / ${esc(langName(lang))}`;

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  view.innerHTML = `
    <div class="layout">
      <aside class="side">${renderSide(files.files, st)}</aside>
      <section>
        <div class="stats">
          <span>Переведено <b>${pct(st.approved, st.total)}%</b></span>
          <span>Утверждено <b>${st.approved}</b></span>
          <span>На голосовании <b>${st.voting}</b></span>
          <span>Устарело <b>${st.stale}</b></span>
          <span>Всего <b>${st.total}</b></span>
          ${game.languages.length > 1 ? `<span>Язык: <select data-act="lang">${game.languages.map((l) => `<option value="${esc(l)}" ${l === lang ? 'selected' : ''}>${esc(langName(l))}</option>`).join('')}</select></span>` : ''}
          <span class="spacer"></span>
          ${st.approved ? `<button class="btn small" data-act="download" data-slug="${esc(slug)}" data-lang="${esc(lang)}">Скачать перевод .zip</button>` : ''}
          ${canManage ? `<a class="btn small" href="#/g/${encodeURIComponent(slug)}/settings">Настройки игры</a>` : ''}
        </div>
        ${renderStageBanner(status?.[lang], canMod)}
        ${!st.total ? `<div class="empty">В игре пока нет строк.${canManage ? ` Загрузите оригинальные файлы в <a href="#/g/${encodeURIComponent(slug)}/settings">настройках игры</a>.` : ''}</div>` : ''}
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

function renderStageBanner(info, canMod) {
  const cur = info?.status || 'open';
  const [, , desc] = stageInfo(cur);
  const when = info?.updated_at ? ` · ${esc(info.by || '')} ${new Date(info.updated_at).toLocaleDateString()}` : '';
  const ctl = canMod
    ? `<span class="spacer"></span><div class="seg" role="group" aria-label="Этап перевода">${STAGES.map(([k, t]) => `<button type="button" data-act="stage" data-v="${k}" class="${k === cur ? 'on' : ''}">${t}</button>`).join('')}</div>`
    : '';
  return `<div class="stage-banner ${cur}">${stageChip(cur)}<span class="muted">${esc(desc)}${when}</span>${ctl}</div>`;
}

function renderString(s) {
  const mod = state.data.canModerate && state.can.approve;
  const { propose: canPropose, vote: canVote } = state.can;
  // Утверждённый вариант уже показан блоком «утверждено» — в списке его не дублируем
  const chosenVariant = s.stale ? null : s.variants.find((v) => v.id === s.approved_variant);
  const approved = s.approved_text != null
    ? `<div class="approved ${s.stale ? 'stale' : ''}">${s.stale ? '<span class="badge">оригинал изменился</span>' : ''}<div class="atext">${esc(s.approved_text)}</div><span class="meta">утверждено${s.approved_by ? ` · ${esc(s.approved_by)}` : ''}${chosenVariant ? ` · автор ${esc(chosenVariant.author || 'аноним')}${chosenVariant.ai ? ' <span class="ai" title="Предложено ИИ-ассистентом через MCP от имени пользователя">ИИ</span>' : ''}${chosenVariant.votes ? ` · ▲ ${chosenVariant.votes}` : ''}` : ''}${mod ? ` · <button class="link" data-act="unapprove" data-id="${s.id}">снять</button>` : ''}</span></div>`
    : '';
  const variants = s.variants
    .filter((v) => v !== chosenVariant)
    .map((v) => {
      const chosen = false;
      const canDelete = me && state.stage !== 'done' && ((v.author === me.login && canPropose) || mod);
      return `<li class="variant">
        <button class="vote ${v.mine ? 'mine' : ''}" data-act="vote" data-id="${v.id}" data-mine="${v.mine ? 1 : 0}" title="${canVote ? (v.mine ? 'Убрать голос' : 'Голосовать') : 'Голосование закрыто на этом этапе'}" ${canVote ? '' : 'disabled'}>▲<span>${v.votes}</span></button>
        <div><div class="vtext ${chosen ? 'chosen' : ''}">${esc(v.text)}</div><div class="vmeta">${esc(v.author || 'аноним')}${v.ai ? ' <span class="ai" title="Предложено ИИ-ассистентом через MCP от имени пользователя">ИИ</span>' : ''}</div></div>
        <div class="vactions">
          ${mod && !chosen ? `<button class="btn small" data-act="approve" data-id="${s.id}" data-variant="${v.id}">Утвердить</button>` : ''}
          ${canDelete ? `<button class="link" data-act="delete" data-id="${v.id}" title="Удалить вариант">удалить</button>` : ''}
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
    ${canPropose || mod ? `<div class="propose">
      <textarea rows="1" placeholder="${me ? 'Ваш вариант перевода' : 'Войдите, чтобы предложить вариант'}" data-act="draft" data-id="${s.id}" ${me ? '' : 'disabled'}></textarea>
      <div class="propose-row" hidden>
        ${canPropose ? `<button class="btn primary small" data-act="propose" data-id="${s.id}">Предложить</button>` : ''}
        ${mod ? `<button class="btn small" data-act="approve-text" data-id="${s.id}">Утвердить этот текст</button>` : ''}
        <button class="link" data-act="copy-source" data-id="${s.id}">вставить оригинал</button>
      </div>
      <ul class="issues"></ul>
    </div>` : ''}
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
      el.classList.toggle('mine', r.mine);
      el.dataset.mine = r.mine ? '1' : '0';
      el.querySelector('span').textContent = r.votes;
      toast(r.mine ? 'Голос учтён' : 'Голос снят', {
        label: r.mine ? 'голос' : 'снятие голоса',
        run: async () => {
          await api(`/variants/${vid}/vote`, { method: r.mine ? 'DELETE' : 'POST' });
          await refreshById(sid);
        },
      });
    } else if (act === 'propose') {
      const ta = card.querySelector('textarea');
      const text = ta.value;
      const r = await api(`/strings/${el.dataset.id}/variants`, { method: 'POST', body: { lang: L, text } });
      toast(r.issues?.length ? 'Вариант добавлен, но есть замечания' : 'Вариант добавлен', {
        label: 'добавление варианта',
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
      toast('Утверждено', { label: 'утверждение', run: restoreApproval });
      await refreshCard(card);
    } else if (act === 'unapprove') {
      await api(`/strings/${el.dataset.id}/approve?lang=${encodeURIComponent(L)}`, { method: 'DELETE' });
      toast('Утверждение снято', { label: 'снятие утверждения', run: restoreApproval });
      await refreshCard(card);
    } else if (act === 'delete') {
      const v = prev.variants.find((x) => x.id === Number(el.dataset.id));
      await api(`/variants/${el.dataset.id}`, { method: 'DELETE' });
      toast('Вариант удалён', {
        label: 'удаление варианта (голоса не вернутся)',
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
    toast(`Этап: ${stageInfo(next)[1]}`, { label: 'смена этапа', run: () => setStage(prev) });
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

await loadMe();
renderAccount();
route();

// ======================================================================
// Управление играми: создание, настройки, загрузка файлов, модераторы
// ======================================================================

const FORMAT_HINTS = {
  rimworld: 'Папки вида Core/Keyed, Core/DefInjected/…, Royalty/… — как в Data/<DLC>/Languages/English',
  json: 'Один или несколько .json файлов',
  'json-nested': 'Один или несколько .json файлов; ключи хранятся через точку',
  gunpoint: 'Папка Scripts с файлами .gpc. Переводятся только строки реплик, номера и пустые строки сохраняются',
};

let formatsCache = null;
async function loadFormats(force = false) {
  if (!formatsCache || force) formatsCache = (await api('/formats')).formats;
  return formatsCache;
}
const fmtInfo = (list, slug) => {
  const f = list.find((x) => x.slug === slug) || { slug, title: slug, extensions: [], kind: 'custom' };
  return { ...f, name: f.title, ext: f.extensions, hint: FORMAT_HINTS[slug] || `Файлы ${f.extensions.join(', ')}` };
};
const KIND_TITLES = { builtin: 'Встроенные', preset: 'Готовые построчные', custom: 'Созданные пользователями' };
function formatOptions(list, selected) {
  return Object.entries(KIND_TITLES)
    .map(([kind, title]) => {
      const items = list.filter((f) => f.kind === kind);
      if (!items.length) return '';
      return `<optgroup label="${title}">${items
        .map((f) => `<option value="${esc(f.slug)}" ${f.slug === selected ? 'selected' : ''}>${esc(f.title)} (${esc(f.extensions.join(', '))})</option>`)
        .join('')}</optgroup>`;
    })
    .join('');
}

const slugify = (t) =>
  t.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

const parseLangs = (v) => v.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

async function renderNewGame() {
  crumbs.innerHTML = `<a href="#/">Игры</a> / Новая игра`;
  document.title = 'Новая игра · LocalizationForum';
  if (!me) {
    view.innerHTML = `<div class="empty">Чтобы добавить игру, <button class="btn primary" data-act="login">войдите через GitHub</button></div>`;
    return;
  }
  const formats = await loadFormats(true);
  view.innerHTML = `
    <form class="panel form" data-form="new-game">
      <h1>Новая игра</h1>
      <label>Название<input name="title" required maxlength="200" placeholder="RimWorld" autocomplete="off"></label>
      <label>Адрес на сайте<input name="slug" required pattern="[a-z0-9][a-z0-9\\-]{0,62}" placeholder="rimworld" autocomplete="off">
        <small>Латиница в нижнем регистре, цифры и дефис. Потом не меняется.</small></label>
      <label>Формат файлов<select name="format">${formatOptions(formats, 'rimworld')}</select>
        <small>Нет нужного? <a href="#/formats">Опишите свой формат</a> — для построчных текстовых файлов это делается без программирования.</small></label>
      <div class="row2">
        <label>Язык оригинала<input name="sourceLang" value="en" required></label>
        <label>Языки перевода<input name="languages" value="ru" required placeholder="ru, uk"><small>Коды через запятую: ru, uk, be, pt-BR</small></label>
      </div>
      <label>Репозиторий GitHub (необязательно)<input name="repo" placeholder="owner/name">
        <small>Если перевод будет выгружаться в репо игры через Actions. Можно указать позже.</small></label>
      <div class="actions"><button class="btn primary">Создать</button><a class="btn" href="#/">Отмена</a></div>
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
      toast('Игра создана. Теперь загрузите оригинальные файлы.');
      location.hash = `#/g/${encodeURIComponent(r.slug)}/settings`;
    } catch (err) {
      form.querySelector('.issues').innerHTML = `<li class="error">${esc(err.message)}</li>`;
    }
  });
}

async function renderSettings(slug, q = new URLSearchParams()) {
  const data = await api(`/games/${encodeURIComponent(slug)}/manage`);
  const { game, moderators, files, strings } = data;
  const formats = await loadFormats(true);
  const fmt = fmtInfo(formats, game.format);
  crumbs.innerHTML = `<a href="#/">Игры</a> / <a href="#/g/${encodeURIComponent(slug)}">${esc(game.title)}</a> / Настройки`;
  document.title = `Настройки — ${game.title} · LocalizationForum`;
  const langOptions = (withAll) =>
    (withAll ? `<option value="*">все языки (управление игрой)</option>` : '') +
    game.languages.map((l) => `<option value="${esc(l)}">${esc(l)} — ${esc(langName(l))}</option>`).join('');

  view.innerHTML = `
    <div class="page-head"><h1>${esc(game.title)}</h1><a class="btn" href="#/g/${encodeURIComponent(slug)}">← К переводу</a></div>
    <div class="settings">
      <form class="panel form" data-form="settings">
        <h2>Основное</h2>
        <label>Название<input name="title" value="${esc(game.title)}" required maxlength="200"></label>
        <div class="row2">
          <label>Языки перевода<input name="languages" value="${esc(game.languages.join(', '))}" required>
            <small>Добавьте код через запятую. Если убрать язык, его переводы сохранятся, но будут скрыты.</small></label>
          <label>Репозиторий GitHub<input name="repo" value="${esc(game.repo || '')}" placeholder="owner/name"></label>
        </div>
        ${strings ? `<p class="muted">Формат: ${esc(fmt.name)}</p>` : `<label>Формат файлов<select name="format">${formatOptions(formats, game.format)}</select><small>Можно сменить, пока не загружены исходники. <a href="#/formats">Свои форматы</a></small></label>`}
        <p class="muted">Адрес: <span class="mono">${esc(game.slug)}</span> · оригинал: ${esc(game.source_lang)}</p>
        <div class="actions"><button class="btn primary">Сохранить</button></div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="source">
        <h2>Оригинальные файлы</h2>
        <p class="muted">Сейчас: <b data-count="files">${files}</b> файлов, <b data-count="strings">${strings}</b> строк. ${esc(fmt.hint)}</p>
        ${filePicker(fmt)}
        <label class="check"><input type="checkbox" name="replace"> Это полный набор файлов: скрыть строки из файлов, которых нет в загрузке</label>
        <div class="actions"><button class="btn primary">Загрузить</button>${files ? `<button type="button" class="btn" data-reparse title="Если формат изменили — заново разобрать уже загруженные оригиналы">Пересчитать строки по формату</button>` : ''}</div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="translation">
        <h2>Импорт готового перевода</h2>
        <p class="muted">Файлы перевода в том же формате и с теми же путями, что и оригинал. Строки станут утверждёнными.</p>
        <label>Язык<select name="lang">${langOptions(false)}</select></label>
        ${filePicker(fmt)}
        <label class="check"><input type="checkbox" name="overwrite"> Перезаписать уже утверждённые строки</label>
        <div class="actions"><button class="btn primary">Импортировать</button></div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form accent" data-form="publish">
        <h2>Опубликовать в GitHub</h2>
        ${publishResult(q.get('pub'))}
        <p class="muted">Одним коммитом в <b>${game.repo ? esc(game.repo) : 'репозиторий из «Основного»'}</b>: оригиналы в <code>source/</code>, утверждённые переводы в <code>&lt;язык&gt;/</code>, <code>game.json</code>. Если репозитория нет — он будет создан (публичный, в вашем аккаунте или организации). GitHub один раз спросит разрешение на запись в публичные репозитории; токен не сохраняется.</p>
        <label>Версия релиза (необязательно)<input name="version" placeholder="например 1.0" pattern="[0-9A-Za-z][0-9A-Za-z._\\-]{0,39}">
          <small>Если указать — для каждого языка появится Release <code>&lt;язык&gt;-&lt;версия&gt;</code> с zip-архивом и списком переводчиков.</small></label>
        <div class="actions"><button class="btn primary" ${game.repo ? '' : 'disabled'}>Опубликовать</button>${game.repo ? `<a href="https://github.com/${esc(game.repo)}" target="_blank" rel="noopener">Открыть репозиторий →</a>` : '<span class="muted">Сначала укажите репозиторий и сохраните</span>'}</div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="moderators">
        <h2>Модераторы</h2>
        <ul class="mods">${moderators
          .map(
            (m) => `<li><span>${m.avatar_url ? `<img class="avatar" src="${esc(m.avatar_url)}&s=40" alt="">` : ''}<b>${esc(m.login)}</b>
              <span class="muted">${m.lang === '*' ? 'все языки, управление игрой' : esc(m.lang)}</span></span>
              <button type="button" class="link" data-act="mod-remove" data-login="${esc(m.login)}" data-lang="${esc(m.lang)}">снять</button></li>`,
          )
          .join('')}</ul>
        <div class="row2">
          <label>Логин GitHub<input name="login" placeholder="nickname" required><small>Человек должен хотя бы раз войти на сайт.</small></label>
          <label>Права<select name="lang">${langOptions(true)}</select></label>
        </div>
        <div class="actions"><button class="btn primary">Назначить</button></div>
        <ul class="issues"></ul>
      </form>

      <form class="panel form" data-form="rules">
        <h2>Правила проверки вариантов</h2>
        <p class="muted">Для каждого языка — список регулярных выражений. Совпадение даёт предупреждение (warn) или запрещает отправку (error).</p>
        <textarea name="rules" class="mono" rows="8" spellcheck="false">${esc(JSON.stringify(game.rules && Object.keys(game.rules).length ? game.rules : { [game.languages[0]]: [{ pattern: '\\s-\\s', message: 'Между словами нужно длинное тире —', level: 'warn' }] }, null, 2))}</textarea>
        <div class="actions"><button class="btn primary">Сохранить правила</button></div>
        <ul class="issues"></ul>
      </form>

      ${me?.is_admin ? `
      <form class="panel form danger" data-form="delete">
        <h2>Удалить игру</h2>
        <p class="muted">Удалятся все строки, варианты, голоса и утверждённые переводы. Отменить нельзя.</p>
        <label><span>Введите адрес игры <b class="mono">${esc(game.slug)}</b> для подтверждения</span><input name="confirm" autocomplete="off"></label>
        <div class="actions"><button class="btn bad">Удалить навсегда</button></div>
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
      toast('Формат сохранён');
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
    toast('Сохранено');
    renderSettings(slug);
  });

  onSubmit('source', async (f) => {
    const files = await collectFiles(f, fmt);
    if (!files.length) throw new Error(`Не выбраны файлы ${fmt.ext.join(', ')}`);
    const total = { added: 0, changed: 0, removed: 0, unchanged: 0 };
    const errors = [];
    const parts = batches(files);
    for (let i = 0; i < parts.length; i++) {
      report(f, [['warn', `Загрузка… пачка ${i + 1} из ${parts.length}`]]);
      const last = i === parts.length - 1;
      const r = await api(`/games/${encodeURIComponent(slug)}/source`, {
        method: 'POST',
        body: { files: parts[i], paths: last && f.replace.checked ? files.map((x) => x.path) : undefined },
      });
      for (const k of Object.keys(total)) total[k] += r[k];
      errors.push(...r.errors);
    }
    report(f, [
      ['ok', `Готово: новых ${total.added}, изменено ${total.changed}, скрыто ${total.removed}, без изменений ${total.unchanged}`],
      ...errors.map((e) => ['error', e]),
    ]);
    toast('Исходники загружены');
    const fresh = await api(`/games/${encodeURIComponent(slug)}/manage`);
    f.querySelector('[data-count=files]').textContent = fresh.files;
    f.querySelector('[data-count=strings]').textContent = fresh.strings;
  });

  forms.source.querySelector('[data-reparse]')?.addEventListener('click', async () => {
    const f = forms.source;
    busy(f, true);
    try {
      const r = await api(`/games/${encodeURIComponent(slug)}/reparse`, { method: 'POST' });
      report(f, [['ok', `Пересчитано: новых ${r.added}, изменено ${r.changed}, скрыто ${r.removed}, без изменений ${r.unchanged}`]]);
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
    if (!files.length) throw new Error(`Не выбраны файлы ${fmt.ext.join(', ')}`);
    const total = { imported: 0, skipped: 0, unknown: 0 };
    for (const part of batches(files)) {
      const r = await api(`/games/${encodeURIComponent(slug)}/translation`, {
        method: 'POST',
        body: { lang: f.lang.value, files: part, overwrite: f.overwrite.checked },
      });
      for (const k of Object.keys(total)) total[k] += r[k];
    }
    report(f, [['ok', `Утверждено ${total.imported}, уже было ${total.skipped}, не найдено в оригинале ${total.unknown}`]]);
  });

  onSubmit('publish', async (f) => {
    const r = await api(`/games/${encodeURIComponent(slug)}/publish/start`, {
      method: 'POST',
      body: { version: f.version.value.trim(), return: location.origin + location.pathname },
    });
    report(f, [['warn', 'Переходим на GitHub для подтверждения…']]);
    location.href = r.url;
  });
  if (q.get('pub')) forms.publish.scrollIntoView({ block: 'center' });

  onSubmit('moderators', async (f) => {
    await api(`/games/${encodeURIComponent(slug)}/moderators`, { method: 'POST', body: { login: f.login.value, lang: f.lang.value } });
    toast('Модератор назначен');
    renderSettings(slug);
  });

  onSubmit('rules', async (f) => {
    let rules;
    try {
      rules = JSON.parse(f.rules.value || '{}');
    } catch (err) {
      throw new Error('Это не JSON: ' + err.message);
    }
    await api(`/games/${encodeURIComponent(slug)}/settings`, { method: 'POST', body: { rules } });
    report(f, [['ok', 'Правила сохранены']]);
  });

  onSubmit('delete', async (f) => {
    if (f.confirm.value.trim() !== game.slug) throw new Error('Адрес не совпадает');
    await api(`/games/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    toast('Игра удалена');
    location.hash = '#/';
  });
}

function filePicker(fmt) {
  return `
    <div class="picker">
      <label class="btn small">Выбрать файлы<input type="file" name="files" multiple accept="${fmt.ext.join(',')}" hidden></label>
      <label class="btn small">Выбрать папку<input type="file" name="folder" webkitdirectory hidden></label>
      <span class="muted picked">ничего не выбрано</span>
    </div>
    <label>Путь внутри оригинала (необязательно)<input name="prefix" placeholder="${fmt.ext.includes('.xml') ? 'Core/Keyed' : 'например locales'}">
      <small>Добавляется перед путями файлов. Для папки берётся её внутренняя структура без имени самой папки.</small></label>`;
}

// Подпись «выбрано N файлов» у пикера
document.addEventListener('change', (e) => {
  const input = e.target;
  if (!input.matches?.('.picker input[type=file]')) return;
  const form = input.closest('form');
  const n = [...form.querySelectorAll('.picker input[type=file]')].reduce((s, i) => s + i.files.length, 0);
  const label = form.querySelector('.picked');
  if (label) label.textContent = n ? `выбрано файлов: ${n}` : 'ничего не выбрано';
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
  const el = e.target.closest('[data-act="download"], [data-act="mod-remove"]');
  if (!el) return;
  try {
    if (el.dataset.act === 'download') {
      el.disabled = true;
      const { slug, lang } = el.dataset;
      const r = await api(`/games/${encodeURIComponent(slug)}/export?lang=${encodeURIComponent(lang)}`);
      if (!r.files.length) return toast('Утверждённых строк пока нет');
      const url = URL.createObjectURL(makeZip(r.files.map((f) => ({ path: `${lang}/${f.path}`, content: f.content }))));
      const a = Object.assign(document.createElement('a'), { href: url, download: `${slug}-${lang}.zip` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast(`Скачано: ${r.translated} из ${r.total} строк`);
    } else {
      const slug = parseRoute().parts[1];
      await api(`/games/${encodeURIComponent(slug)}/moderators`, { method: 'POST', body: { login: el.dataset.login, lang: el.dataset.lang, remove: true } });
      toast('Права сняты');
      renderSettings(slug);
    }
  } catch (err) {
    toast(err.message);
  } finally {
    el.disabled = false;
  }
});

// ---------- форматы файлов: список и редактор ----------

const CONFIG_HELP = `
  <details class="help"><summary>Как описать формат</summary>
  <p>Построчный формат описывается JSON-объектом. Файл перевода собирается поверх оригинала: меняется только найденный текст, всё остальное остаётся байт в байт.</p>
  <ul>
    <li><b>extensions</b> — расширения файлов: <code>[".gpc"]</code></li>
    <li><b>mode</b> — <code>"lines"</code>: ключ строки = её номер в файле; <code>"keyValue"</code>: ключ берётся из группы <code>(?&lt;key&gt;…)</code></li>
    <li><b>text</b> — регулярное выражение для строки, переводимая часть — группа <code>(?&lt;text&gt;…)</code>. По умолчанию: вся непустая строка (lines) или <code>key=value</code> (keyValue)</li>
    <li><b>skip</b> — список выражений для строк, которые никогда не переводятся (пустые, номера…)</li>
    <li><b>contextLine</b> — строка-заголовок с группой <code>(?&lt;label&gt;…)</code>: не переводится и показывается переводчикам как контекст следующих строк (имя говорящего, секция)</li>
    <li><b>comment</b> — выражение для строк-комментариев</li>
  </ul>
  <p>Проверьте формат на настоящем файле: должно быть «собирается обратно без изменений».</p>
  </details>`;

async function renderFormats(slug, q) {
  const formats = await loadFormats(true);
  crumbs.innerHTML = `<a href="#/">Игры</a> / <a href="#/formats">Форматы</a>${slug ? ' / ' + esc(slug) : ''}`;
  document.title = 'Форматы файлов · LocalizationForum';
  if (!slug) {
    view.innerHTML = `
      <div class="page-head"><h1>Форматы файлов</h1>${me ? `<a class="btn primary" href="#/formats/new">+ Свой формат</a>` : ''}</div>
      <p class="muted">Встроенные форматы разбирают сложные файлы (XML RimWorld, JSON). Построчные описываются данными — их может создать любой участник.</p>
      <div class="formats">${formats
        .map(
          (f) => `<a class="card fmt" href="#/formats/${encodeURIComponent(f.slug)}">
            <b>${esc(f.title)}</b>
            <span class="muted mono">${esc(f.slug)} · ${esc(f.extensions.join(', '))}</span>
            <span class="badge-kind ${f.kind}">${KIND_TITLES[f.kind]}${f.owner ? ' · ' + esc(f.owner) : ''}</span>
          </a>`,
        )
        .join('')}</div>`;
    return;
  }

  const isNew = slug === 'new';
  const base = isNew ? formats.find((f) => f.slug === (q.get('from') || 'plain-lines')) : formats.find((f) => f.slug === slug);
  if (!isNew && !base) throw new Error('Формат не найден');
  const editable = isNew || (base.kind === 'custom' && me && (me.is_admin || base.owner === me.login));
  const lineBased = isNew || base.kind !== 'builtin';
  const config = base?.config ?? { extensions: ['.txt'], mode: 'lines', skip: ['^\\s*$'] };

  view.innerHTML = `
    <form class="panel form" data-form="format">
      <div class="page-head"><h1>${isNew ? 'Новый формат' : esc(base.title)}</h1>
        ${!isNew && lineBased && me ? `<a class="btn" href="#/formats/new?from=${encodeURIComponent(base.slug)}">Создать копию</a>` : ''}</div>
      ${!isNew ? `<p class="muted">${KIND_TITLES[base.kind]} · <span class="mono">${esc(base.slug)}</span>${base.owner ? ' · автор ' + esc(base.owner) : ''}</p>` : ''}
      ${!lineBased ? `<p>Это встроенный формат: он написан кодом и не редактируется. Расширения: ${esc(base.extensions.join(', '))}.</p>` : ''}
      ${isNew ? `
        <div class="row2">
          <label>Код<input name="slug" required pattern="[a-z0-9][a-z0-9\\-]{1,40}" placeholder="my-game-dialogs" autocomplete="off"><small>Латиница, цифры, дефис</small></label>
          <label>Название<input name="title" required maxlength="120" placeholder="Диалоги My Game (.dlg)"></label>
        </div>
        <label>На основе<select name="from">${formats
          .filter((f) => f.kind !== 'builtin')
          .map((f) => `<option value="${esc(f.slug)}" ${f.slug === base?.slug ? 'selected' : ''}>${esc(f.title)}</option>`)
          .join('')}</select></label>` : editable ? `<label>Название<input name="title" value="${esc(base.title)}" maxlength="120"></label>` : ''}
      ${lineBased ? `
        <label>Описание формата (JSON)<textarea name="config" class="mono" rows="10" spellcheck="false" ${editable ? '' : 'readonly'}>${esc(JSON.stringify(config, null, 2))}</textarea></label>
        ${CONFIG_HELP}` : ''}
      <h2>Проверка на файле</h2>
      <div class="picker"><label class="btn small">Выбрать файл<input type="file" name="sample" hidden></label><span class="muted picked-sample">файл не выбран</span></div>
      <div class="preview"></div>
      ${editable ? `<div class="actions"><button class="btn primary">${isNew ? 'Создать формат' : 'Сохранить'}</button></div>` : ''}
      <ul class="issues"></ul>
    </form>`;

  const form = view.querySelector('form');
  const report = (items) => (form.querySelector('.issues').innerHTML = items.map(([l, m]) => `<li class="${l}">${esc(m)}</li>`).join(''));
  const readConfig = () => {
    try {
      return JSON.parse(form.config.value);
    } catch (e) {
      throw new Error('Описание — не JSON: ' + e.message);
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
    if (!me) return (box.innerHTML = `<p class="muted">Войдите, чтобы проверить файл.</p>`);
    try {
      const body = { path: sample.name, content: sample.content, ...(lineBased ? { config: readConfig() } : { format: base.slug }) };
      const r = await api('/formats/preview', { method: 'POST', body });
      box.innerHTML = `
        <ul class="issues">
          <li class="${r.matches ? 'ok' : 'warn'}">${r.matches ? 'Расширение файла подходит' : 'Расширение файла не входит в extensions — при загрузке такой файл будет пропущен'}</li>
          <li class="${r.count ? 'ok' : 'warn'}">Найдено строк для перевода: ${r.count}</li>
          ${r.roundTrip === null ? '' : `<li class="${r.roundTrip ? 'ok' : 'error'}">${r.roundTrip ? 'Файл собирается обратно без изменений' : 'Файл НЕ собирается обратно байт в байт — проверьте выражения'}</li>`}
        </ul>
        ${r.count ? `<table class="ptable"><thead><tr><th>Ключ</th><th>Контекст</th><th>Текст</th></tr></thead><tbody>${r.strings
          .slice(0, 60)
          .map((x) => `<tr><td class="mono">${esc(x.key)}</td><td class="muted">${esc(x.context || '')}</td><td>${esc(x.source)}</td></tr>`)
          .join('')}</tbody></table>${r.count > 60 ? `<p class="muted">…и ещё ${r.count - 60}</p>` : ''}` : ''}`;
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
  let t;
  form.config?.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(runPreview, 600);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const config = readConfig();
      if (isNew) {
        await api('/formats', { method: 'POST', body: { slug: form.slug.value.trim(), title: form.title.value, config } });
        toast('Формат создан');
        location.hash = `#/formats/${encodeURIComponent(form.slug.value.trim())}`;
      } else {
        const r = await api(`/formats/${encodeURIComponent(base.slug)}`, { method: 'POST', body: { title: form.title?.value, config } });
        report([['ok', 'Сохранено'], ...(r.games.length ? [['warn', `Формат используют игры: ${r.games.join(', ')}. Чтобы строки пересчитались, загрузите исходники заново.`]] : [])]);
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
  if (r.error) return `<ul class="issues"><li class="error">Публикация не удалась: ${esc(r.error)}</li></ul>`;
  const parts = [
    r.created ? `Создан репозиторий <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.repo)}</a>.` : `Репозиторий <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.repo)}</a>.`,
    r.commit ? `Коммит <a href="${esc(r.url)}/commit/${esc(r.commit)}" target="_blank" rel="noopener">${esc(r.commit.slice(0, 7))}</a>, файлов: ${r.files}.` : 'Изменений нет — всё уже опубликовано.',
    ...(r.releases || []).map((t) => `Релиз <a href="${esc(r.url)}/releases/tag/${esc(t)}" target="_blank" rel="noopener">${esc(t)}</a>.`),
  ];
  return `<ul class="issues"><li class="ok">Опубликовано. ${parts.join(' ')}</li></ul>`;
}

// ---------- токены и подключение MCP ----------
async function renderTokens() {
  crumbs.innerHTML = `<a href="#/">Игры</a> / Токены и MCP`;
  document.title = 'Токены и MCP · LocalizationForum';
  if (!me) {
    view.innerHTML = `<div class="empty"><button class="btn primary" data-act="login">Войдите через GitHub</button></div>`;
    return;
  }
  const { tokens } = await api('/tokens');
  const mcpUrl = (window.FORUM_API || location.origin) .replace(/\/$/, '') + '/api/mcp';
  view.innerHTML = `
    <div class="page-head"><h1>Токены и MCP</h1></div>
    <div class="settings">
      <section class="panel form">
        <h2>Подключить к Claude</h2>
        <p>MCP-сервер форума даёт ИИ-ассистенту инструменты: искать строки, предлагать переводы, голосовать и, если вы модератор, утверждать. Всё делается от вашего имени, а варианты получают значок <span class="ai">ИИ</span>.</p>
        <div class="copy-row"><code>${esc(mcpUrl)}</code><button class="btn small" type="button" data-copy="${esc(mcpUrl)}">Копировать</button></div>
        <p class="muted"><b>Claude (сайт, приложение, Cowork):</b> Настройки → Коннекторы → Добавить свой коннектор → вставьте адрес. При подключении откроется вход через GitHub и запрос разрешения — токен не нужен.</p>
        <p class="muted"><b>Claude Code:</b> <code>claude mcp add --transport http localization-forum ${esc(mcpUrl)}</code> — вход тоже через браузер. Или с токеном: добавьте <code>--header "Authorization: Bearer &lt;токен&gt;"</code>.</p>
        <p class="muted"><b>Cursor и другие:</b> URL сервера и заголовок <code>Authorization: Bearer &lt;токен&gt;</code>.</p>
      </section>
      <form class="panel form" data-form="new-token">
        <h2>Персональный токен</h2>
        <p class="muted">Для клиентов, где нельзя войти через браузер. Токен даёт те же права, что и ваш аккаунт — не публикуйте его.</p>
        <div class="row2"><label>Название<input name="name" placeholder="например, Cursor на ноутбуке" maxlength="100"></label><div class="actions" style="align-self:end"><button class="btn primary">Создать токен</button></div></div>
        <div class="new-token"></div>
        <ul class="issues"></ul>
      </form>
      <section class="panel">
        <h2>Выданные доступы</h2>
        ${tokens.length ? `<ul class="mods">${tokens
          .map(
            (t) => `<li><span><b>${esc(t.name)}</b><span class="muted">${t.kind === 'oauth' ? 'подключение OAuth' : 'персональный'} · создан ${new Date(t.created_at).toLocaleDateString('ru')}${t.last_used_at ? ' · использован ' + new Date(t.last_used_at).toLocaleString('ru') : ' · не использовался'}</span></span>
            <button class="link" data-act="token-revoke" data-id="${t.id}">отозвать</button></li>`,
          )
          .join('')}</ul>` : '<p class="muted">Пока нет.</p>'}
      </section>
    </div>`;
  const form = view.querySelector('[data-form=new-token]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/tokens', { method: 'POST', body: { name: form.name.value } });
      form.querySelector('.new-token').innerHTML = `<div class="token-box"><code>${esc(r.token)}</code><button class="btn small" type="button" data-copy="${esc(r.token)}">Копировать</button></div><p class="muted">Скопируйте сейчас — повторно токен не показывается.</p>`;
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
      toast('Скопировано');
    } catch {
      toast('Не удалось скопировать — выделите текст вручную');
    }
    return;
  }
  const rev = e.target.closest('[data-act=token-revoke]');
  if (rev) {
    try {
      await api(`/tokens/${rev.dataset.id}`, { method: 'DELETE' });
      toast('Доступ отозван');
      renderTokens();
    } catch (err) {
      toast(err.message);
    }
  }
});


// ---------- список файлов: сортировка как в таблице ----------
const FILE_SORTS = [
  ['name', 'Имя'],
  ['done', 'Готово'],
  ['total', 'Строк'],
];

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
  const head = `<div class="side-sort">${FILE_SORTS.map(
    ([k, title]) => `<button type="button" data-act="file-sort" data-k="${k}" class="${sort.key === k ? 'on' : ''}" title="Сортировать: ${title.toLowerCase()}">${title}${sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button>`,
  ).join('')}</div>`;
  // +N — строки, у которых есть предложенные варианты, но ещё нет утверждённого перевода
  const plus = (n) => (n ? `<span class="vcount" title="Строк с вариантами без утверждения: ${n}">+${n}</span> ` : '');
  const all = `<a href="${href(slug, lang, { ...params, file: '', page: 1 })}" class="${params.file ? '' : 'on'}"><span class="fname">Все файлы</span><small>${plus(st.voting)}${st.approved}/${st.total}</small></a>`;
  const rows = sortFiles(files)
    .map((f) => {
      const i = f.file.lastIndexOf('/');
      const dir = i >= 0 ? f.file.slice(0, i + 1) : '';
      const p = f.total ? Math.round((f.approved / f.total) * 100) : 0;
      const pv = f.total ? Math.round(((f.voting || 0) / f.total) * 100) : 0;
      return `<a href="${href(slug, lang, { ...params, file: f.file, page: 1 })}" class="${f.file === params.file ? 'on' : ''}" title="${esc(f.file)} — утверждено ${p}%${f.voting ? `, с вариантами ещё ${f.voting}` : ''}"><span class="fname">${dir ? `<span class="dir">${esc(dir)}</span>` : ''}${esc(f.file.slice(i + 1))}</span><small class="${f.approved === f.total ? 'done' : ''}">${plus(f.voting)}${f.approved}/${f.total}</small><i class="fbar" style="width:${p}%"></i>${pv ? `<i class="fbar vbar" style="left:${p}%;width:${pv}%"></i>` : ''}</a>`;
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
