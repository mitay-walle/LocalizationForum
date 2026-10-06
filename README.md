# LocalizationForum

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
   `JWT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SITE_ORIGINS`, `ADMIN_LOGINS`, `SYNC_TOKEN`, по желанию `GITHUB_DISPATCH_TOKEN`. После — Redeploy.
5. **GitHub Pages:** Settings → Pages → Source: **GitHub Actions**. Settings → Secrets and variables → Actions → **Variables** → `FORUM_API_URL = https://<проект>.vercel.app`. Запустить workflow **Pages**.

Проверка: `https://<проект>.vercel.app/api/health` → `{"ok":true}`.

## Добавить игру

1. Скопировать `game-template/` в новый репозиторий (например `<user>/rimworld-loc`), заполнить `game.json`, положить оригинал в `source/`.
2. В репо игры: Variables → `FORUM_API_URL`, Secrets → `FORUM_SYNC_TOKEN` (= `SYNC_TOKEN` форума).
3. Push → workflow **Import source** загрузит строки, игра появится на сайте.
4. Модераторы: администратор (из `ADMIN_LOGINS`) назначает их запросом
   `POST /api/admin/moderators {"game":"slug","lang":"ru","login":"nick"}` (lang `*` — все языки). Человек должен хотя бы раз войти на сайт.

Подробнее — `game-template/README.md`.

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
| POST | `/api/strings/:id/variants` `{lang, text, check?}` | вошедшие |
| POST/DELETE | `/api/variants/:id/vote` | вошедшие |
| DELETE | `/api/variants/:id` | автор / модератор |
| POST/DELETE | `/api/strings/:id/approve` `{lang, variantId \| text}` | модератор |
| POST | `/api/admin/moderators` | администратор |
| POST | `/api/admin/import`, `/api/admin/import/finish` | Actions репо игры (`X-Sync-Token`) |
