# LocalizationForum — для разработчиков

Техническое описание: архитектура, развёртывание, локальная разработка и API. Что такое форум и как им пользоваться — в [README](../README.md).

Коллективный перевод игр в духе Zone of Games: участники предлагают варианты перевода строк, голосуют, модератор утверждает. Утверждённый перевод автоматически попадает в репозиторий игры в её родном формате, а релизы собираются через GitHub Releases.

```
GitHub Pages (site/)  ──чтение/запись──▶  Vercel Function (api/ → src/app.ts)  ──▶  Neon Postgres
                                                     ▲
             репо игры (из game-template/) ──Actions─┘  импорт исходников / выгрузка перевода / релизы
```

- **Сайт** — статический, без сборки (`site/`), публикуется на GitHub Pages; заодно доступен и на Vercel.
- **API** — одна функция Vercel на [Hono](https://hono.dev) (`src/app.ts`), регион `fra1`.
- **БД** — Postgres (Neon, бесплатный тариф). Миграции применяются автоматически при каждом деплое.
- **Вход** — GitHub OAuth. Токен GitHub не хранится, сессия — подписанный JWT.
- **Форматы игр** — `src/formats/`: `rimworld` (Keyed/DefInjected XML), `json`, `json-nested`. Новый формат = файл с `parse`/`serialize`.
- **Проверки варианта** — `src/validate.ts`: плейсхолдеры `{0}`/`{PAWN_x}`/`%d`, теги `<color>`/`[b]`, `\n` + правила языка из `rules/<lang>.json` репо игры.

## Развёртывание (один раз)

1. **Vercel → Add New → Project → Import** этого репозитория. Framework: Other, остальное подхватится из `vercel.json`.
2. **База:** в проекте Vercel → Storage → Create Database → **Neon** (Free). Vercel сам добавит `DATABASE_URL`. Регион — Frankfurt.
3. **GitHub OAuth App:** GitHub → Settings → Developer settings → OAuth Apps → New.
   - Homepage URL: `https://<user>.github.io/LocalizationForum/`
   - Callback URL: `https://<проект>.vercel.app/api/auth/callback`
4. **Переменные окружения** в Vercel (Settings → Environment Variables), см. `.env.example`:
   `JWT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SITE_ORIGINS`, `ADMIN_LOGINS`, `SYNC_TOKEN`, по желанию `GITHUB_DISPATCH_TOKEN` и лимиты `VARIANTS_PER_USER_STRING` / `VARIANTS_PER_STRING` / `VARIANTS_PER_HOUR`. После — Redeploy.
5. **GitHub Pages:** Settings → Pages → Source: **GitHub Actions**. Settings → Secrets and variables → Actions → **Variables** → `FORUM_API_URL = https://<проект>.vercel.app`. Запустить workflow **Pages**.

Проверка: `https://<проект>.vercel.app/api/health` → `{"ok":true}`.

## Добавить игру

**С сайта** (проще): войти → «+ Новая игра» → указать название, формат и языки → в «Настройках игры» загрузить оригинальные файлы (файлы или целую папку). Там же: языки, импорт готового перевода, модераторы, правила проверок. Создатель игры получает права на все её языки. Скачать перевод .zip можно со страницы перевода.

**Через репозиторий игры** (если перевод должен коммититься в GitHub и выходить релизами):

1. Скопировать `game-template/` в новый репозиторий (например `<user>/rimworld-loc`), заполнить `game.json`, положить оригинал в `source/`.
2. В репо игры: Variables → `FORUM_API_URL`, Secrets → `FORUM_SYNC_TOKEN` (= `SYNC_TOKEN` форума).
3. Push → workflow **Import source** загрузит строки, игра появится на сайте.
4. Модераторы: администратор (из `ADMIN_LOGINS`) назначает их запросом
   `POST /api/admin/moderators {"game":"slug","lang":"ru","login":"nick"}` (lang `*` — все языки). Человек должен хотя бы раз войти на сайт.

Подробнее — [`game-template/README.md`](../game-template/README.md).

## Разработка

```bash
npm install
cp .env.example .env        # DATABASE_URL на локальный Postgres или ветку Neon, DEV_AUTH=1
npm run migrate && npm run seed
npm run dev                 # http://localhost:3000 — сайт + API
```

С `DEV_AUTH=1` вход без GitHub: `http://localhost:3000/api/auth/dev?login=admin` (на Vercel выключен всегда). Логин из `ADMIN_LOGINS` получает права администратора.

```bash
npm test                    # юнит-тесты; интеграционные — если задан TEST_DATABASE_URL (база будет очищена)
npm run typecheck
```

## API

| Метод | Путь | Кто |
|---|---|---|
| GET | `/api/games`, `/api/games/:slug`, `/api/games/:slug/files?lang=` | все |
| GET | `/api/games/:slug/strings?lang=&file=&filter=all\|untranslated\|voting\|approved\|stale&q=&page=` | все |
| GET | `/api/games/:slug/export?lang=`, `/api/games/:slug/credits?lang=` | все |
| POST | `/api/strings/:id/variants` `{lang, text, check?}` — с лимитами (см. «Антиспам») | вошедшие, не забаненные |
| POST/DELETE | `/api/variants/:id/vote` — один голос на строку+язык: POST снимает голос пользователя с других вариантов строки и возвращает их id в `cleared` | вошедшие |
| DELETE | `/api/variants/:id` | автор / модератор |
| POST/DELETE | `/api/strings/:id/approve` `{lang, variantId \| text}` | модератор |
| POST | `/api/games` `{slug, title, format, sourceLang, languages, repo?}` | вошедшие (создатель → модератор `*`) |
| GET | `/api/games/:slug/manage` | модератор `*` / админ |
| POST | `/api/games/:slug/settings` `{title?, languages?, repo?, rules?}` | модератор `*` / админ |
| POST | `/api/games/:slug/source` `{files, paths?}` | модератор `*` / админ |
| POST | `/api/games/:slug/translation` `{lang, files, overwrite?}` | модератор `*` / админ |
| POST | `/api/games/:slug/moderators` `{login, lang, remove?}` | модератор `*` / админ |
| DELETE | `/api/games/:slug` | администратор |
| POST | `/api/admin/moderators` | администратор |
| POST | `/api/admin/import`, `/api/admin/import/finish` | Actions репо игры (`X-Sync-Token`) |

## Антиспам: лимиты и баны

**Лимиты** на `POST /api/strings/:id/variants` (переменные окружения, `0` — без лимита; модераторы языка и администраторы не ограничены; код — `src/limits.ts`):

| Переменная | По умолчанию | Что ограничивает | Ответ |
|---|---|---|---|
| `VARIANTS_PER_USER_STRING` | 3 | своих вариантов у строки на одном языке | 422 |
| `VARIANTS_PER_STRING` | 30 | всего вариантов у строки на одном языке | 422 |
| `VARIANTS_PER_HOUR` | 500 | вариантов пользователя за последний час по всему сайту | 429 |

Проверка и вставка идут в одной транзакции под advisory-lock пользователя. Текущие лимиты приходят в ответах `GET /api/games/:slug` и `/strings` (`limits`) — сайт по ним прячет поле ввода, а MCP-инструкция их называет. Пакет `propose_translations` (до 50 строк) укладывается в часовой лимит.

**Баны** — таблица `bans` (миграция `006_bans.sql`): `game_id = null` — на весь форум, `until = null` — бессрочно, истёкшие не действуют. Забаненный читает, но получает 403 (с причиной и сроком) на: предложение/удаление вариантов, голоса, утверждение, смену этапа, создание игр и форматов, загрузку и настройки игры; MCP-инструменты записи идут через тот же API. Действующие баны текущего пользователя — в `GET /api/me` (`bans`) и `GET /api/games/:slug` (`ban`).

| Метод | Путь | Кто |
|---|---|---|
| GET/POST/DELETE | `/api/games/:slug/bans` — бан в игре | управляющий игрой (модератор `*`) / админ |
| GET/POST/DELETE | `/api/admin/bans` — бан на весь форум | администратор |

`POST` `{login, reason, days?, purge?}`: без `days` — навсегда; `purge: true` удаляет варианты и голоса пользователя в игре (или везде при глобальном бане), кроме вариантов, выбранных как утверждённые. Нельзя забанить себя; администратора — только администратор. `DELETE ?id=` или `?login=` снимает бан(ы) в этой области. `GET` — действующие баны.

## Язык интерфейса сайта

Интерфейс переведён на несколько языков (не путать с языками перевода игр в адресах вида `#/g/slug/ru`).

- `site/i18n.js` — `t(key, params)` с подстановкой `{param}` и формами множественного числа (`{ one, few, many, other }` по `Intl.PluralRules`), выбор языка: сохранённый в `localStorage.ui.locale` → язык браузера → английский.
- `site/locales/<код>.js` — словари (`ru` — исходный, `en` — запасной: недостающие ключи берутся из него). Подгружаются по требованию.
- Новый язык: скопировать `en.js`, перевести, добавить код и самоназвание в `LOCALES` в `site/i18n.js` (и строку «Загрузка…» во встроенный скрипт `site/index.html`).
- Новый текст в интерфейсе: ключ во все словари. Ошибки API приходят с сервера по-русски; клиент отправляет `Accept-Language` на будущее.

## README репозитория игры

При каждой публикации («Опубликовать в GitHub») README.md репозитория игры генерируется заново (`src/readme.ts`): инструкция для игроков — скачать Release своего языка и распаковать поверх игры — на языке каждого перевода плюс английский обзор и структура папок внизу.
