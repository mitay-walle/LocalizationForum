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
- **Форматы файлов** — `src/formats/`: `rimworld` (Keyed/DefInjected XML), `json`, `json-nested`, построчные (пресеты `gunpoint`, `properties`, `plain-lines` и пользовательские из `custom_formats`). Формат — у каждого файла свой, по расширению (см. «Форматы по файлам»). Новый формат = файл с `parse`/`serialize`.
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

**С сайта** (проще): войти → «+ Новая игра» → указать название и языки → в «Настройках игры» загрузить оригинальные файлы (файлы или целую папку). Там же: языки, импорт готового перевода, модераторы, правила проверок. Создатель игры получает права на все её языки. Скачать перевод .zip можно со страницы перевода.

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
| POST | `/api/games` `{slug, title, sourceLang, languages, format?, format_map?, repo?, description?, links?, cover_url?}` | вошедшие (создатель → модератор `*`) |
| GET | `/api/games/:slug/manage` | модератор `*` / админ |
| POST | `/api/games/:slug/settings` `{title?, languages?, force?, repo?, rules?, description?, links?, cover_url?, encodings?, format?, format_map?}` | модератор `*` / админ |
| POST | `/api/games/:slug/reparse` — заново разобрать сохранённые оригиналы по текущей карте форматов | модератор `*` / админ |
| GET | `/api/games/:slug/source/files` — оригиналы `{files: [{path, format, encoding, size, strings}], trash: [{path, format, size, deleted_at, deleted_by}], trashDays}` | модератор `*` / админ |
| GET | `/api/games/:slug/source/raw?path=` — оригинал байт в байт (`attachment`) | модератор `*` / админ |
| DELETE | `/api/games/:slug/source?path=` — удалить один оригинал (в корзину) | модератор `*` / админ, не забаненный |
| POST | `/api/games/:slug/source/delete` `{paths}` или `{prefix}` → `{deleted, files, strings}` | модератор `*` / админ, не забаненный |
| POST | `/api/games/:slug/source/restore` `{paths}` → `{restored, files, strings, skipped, errors}` | модератор `*` / админ, не забаненный |
| POST | `/api/games/:slug/source` `{files, paths?}` | модератор `*` / админ |
| POST | `/api/games/:slug/translation` `{lang, files, overwrite?}` | модератор `*` / админ |
| POST | `/api/games/:slug/moderators` `{login, lang, remove?}` | модератор `*` / админ |
| DELETE | `/api/games/:slug` | администратор |
| POST | `/api/admin/moderators` | администратор |
| POST | `/api/admin/import`, `/api/admin/import/finish` | Actions репо игры (`X-Sync-Token`) |

## Бесплатные лимиты и как мы их экономим

Форум живёт на бесплатных тарифах, поэтому главное — не будить функцию и базу без нужды.

| Сервис | Лимиты в месяц | Если превысить |
|---|---|---|
| **Vercel Hobby** (только некоммерческое использование; донаты допустимы) | 1 млн вызовов функций, 4 CPU-часа, 360 ГБ-часов памяти, 100 ГБ трафика | функции ставятся на паузу (~30 дней или до апгрейда) — API не отвечает |
| **Neon Free** | 100 CU-часов, 1 ГБ данных, 5 ГБ исходящего трафика | база приостанавливается до следующего месяца |

Neon засыпает через 5 минут простоя, и каждое пробуждение — это минимум ~5 минут работы на 0,25 CU. Поэтому всё, что ходит в API по расписанию, расходует квоту даже при нулевой посещаемости.

Что сделано:

1. **Никакого опроса по расписанию.** `Sync translations` в репо игр запускается по `repository_dispatch` после утверждений, вручную и раз в сутки (`41 3 * * *`), а не раз в час. Форум шлёт dispatch не чаще раза в 10 минут на игру (`notifyRepo`), а workflow ждёт 10 минут перед выгрузкой — так все утверждения пачки попадают в один запуск. Workflow самого форума (`ci.yml`) к API не ходит; `pages.yml` обращается раз в сутки за снимком.
2. **Кэш CDN для анонимного чтения.** `GET /api/games`, `/games/:slug`, `/files`, `/strings`, `/credits`, `/formats` без `Authorization` и без cookie получают `Cache-Control: public, s-maxage=60, stale-while-revalidate=600` (`/export` — 300/3600) и `Vary: Origin`; повторные запросы гостей обслуживает CDN Vercel без вызова функции и без базы. Ответы вошедшим (в них личные поля: `mine`, `canModerate`, `ban`) — `private, no-store`, а CDN Vercel запросы с `Authorization` и так не кэширует. MCP SDK, zod и модуль публикации грузятся лениво — обычный холодный старт их не разбирает.
3. **Зеркало только для чтения на GitHub Pages.** `scripts/snapshot.mjs` раз в сутки (и при изменении сайта) сохраняет анонимные ответы API в `site/data/` (`pages.yml`). Если запрос на чтение к API не удался (сеть, 8 с тайм-аут, 5xx, 402, 429), сайт показывает плашку «сохранённая копия от …» и читает снимок: на github.io — `./data/`, с Vercel — `https://mitay-walle.github.io/LocalizationForum/data/` (можно переопределить `window.FORUM_SNAPSHOT` в `config.js`). Фильтры, поиск и файлы строк работают по снимку локально, запись выключена. Пока API отвечает, к снимку нет ни одного запроса.

Снимок вручную: `FORUM_API=http://localhost:3000/api node scripts/snapshot.mjs /tmp/snap`. Готовый `pages.yml` лежит и в `docs/pages.yml.new` — на случай, если файл в `.github/workflows` удобнее обновить через веб-редактор GitHub.

## Ревизии перевода

Миграция `009_revisions.sql`: `language_status.revision` (с 1) и `approved_history` (архив утверждений с номером ревизии).

- `POST /api/games/:slug/revision {lang, stage?: 'open'|'review'}` — модератор языка / управляющий / админ, не забаненный. В одной транзакции: тексты утверждений без варианта становятся вариантами (автор — утвердивший модератор, `ai=false`), все утверждения языка копируются в `approved_history` (с `variant_id`) и удаляются, `revision + 1`, этап — `stage` или прежний. На этапе «Готово» без `stage` — 422. Ответ `{revision, archived, stage, previousStage}`.
- `POST /api/games/:slug/revision/undo {lang, stage?}` — вернуть утверждения прошлой ревизии и (если передан) этап; 409, если ревизия первая или в новой уже что-то утверждено.
- Номер ревизии: `GET /games/:slug` → `status[lang].revision`, `/strings` → `revision`; у вариантов `was_approved_rev` — последняя ревизия, в которой этот текст был утверждён (бейдж на карточке). MCP только читает ревизию (`find_strings.revision`, `was_approved_in_revision`). Заметки к релизу: «версия X, ревизия N». Экспорт после новой ревизии — по текущим правилам: неутверждённые строки выгружаются текстом оригинала.

## Кодировки файлов

- **Определение** — в браузере при загрузке (`site/encoding.js`, его же используют тесты): BOM UTF-8 → `utf-8-bom`, BOM UTF-16 → `utf-16le-bom` / `utf-16be-bom`, корректный UTF-8 → `utf-8`, иначе догадка `windows-1252`; в форме загрузки кодировку можно выбрать вручную. Файл декодируется `TextDecoder`, переводы строк (CRLF) не трогаются; в API уходит `{path, content, encoding}`. Скрипт репо игры (`game-template/scripts/forum.mjs`) определяет так же (`FORUM_SOURCE_ENCODING` — для однобайтовых не-windows-1252).
- **Хранение** (миграция `008_encodings.sql`): `source_files.encoding` — у каждого оригинала (для всех форматов); `games.encodings` — `{язык: кодировка}` для выгрузки, нет языка — «как в оригинале» (кодировка каждого файла); `games.source_encoding` — самая частая, для информации.
- **Выгрузка**: `exportLanguage` отдаёт у каждого файла `encoding` (настройка языка или кодировка оригинала); у `.xml` атрибут `encoding` в декларации приводится к ней. `GET /api/games/:slug/export?lang=…&binary=1` — готовые байты в base64 (`data`), с BOM; их используют zip на сайте, `forum.mjs export` и релизы. «Опубликовать в GitHub» пишет UTF-8 без BOM текстом, остальное — через `POST /git/blobs {encoding: 'base64'}` и `sha` в дереве; оригиналы в `source/` — в их собственной кодировке. Кодирование — `iconv-lite` (чистый JS), `src/encoding.ts`.
- **Проверка**: `checkText` добавляет ошибку, если в тексте есть символы, которых нет в целевой кодировке файла для языка (только неюникодные кодировки): «Символ «ё» нельзя записать в кодировке windows-1252 — выберите другую кодировку в настройках игры». `GET /manage` отдаёт `fileEncodings` и `encodingSupport` (для каждого языка — кодировки, в которых нельзя записать его характерные буквы) — по ним настройки показывают предупреждение и подсказку.
- Поддерживаются: `utf-8`, `utf-8-bom`, `utf-16le-bom`, `utf-16be-bom`, `windows-1252`, `windows-1251`, `windows-1250`, `iso-8859-1`, `koi8-r`, `shift_jis`, `gb18030`, `big5`, `euc-kr`. Настройка: `POST /settings {encodings: {ru: "utf-8"}}` (передаётся целиком, пустое значение — «как в оригинале»).

## Форматы по файлам

Формат выбирается у каждого файла по расширению (миграция `010_format_map.sql`):

- **`games.format_map`** — `{".xml": "rimworld", ".gpc": "gunpoint", ".png": "-"}`; ключи — расширение в нижнем регистре с точкой или `"*"` (все остальные), значения — slug формата или `"-"` (не переводить, копировать как есть). Разрешение (`fileFormat` в `src/formats/index.ts`): расширение → `"*"` → `games.format` (формат по умолчанию — только для старых игр и файлов без расширения; у новых игр пустой).
- **Автоподбор** (`prepareFiles` в `src/sync.ts`): расширения, которых нет в карте (и нет `"*"`), получают формат при загрузке — кандидаты из объявленных расширений (`BUILTIN.extensions`, `config.extensions` построчных); `games.format` проверяется первым; берётся первый, кто находит строки и собирает образцы этой пачки обратно в то же самое (так вложенный `.json` получает `json-nested`, плоский — `json`), иначе — нашедший больше строк; никто не нашёл строк или кандидатов нет — `"-"`. Новые записи дописываются в карту и возвращаются в ответе загрузки как `formats`; `raw` — число файлов «как есть».
- **`source_files.format`** — каким форматом файл разобран при последней загрузке. Экспорт, `checkText` (проверка варианта и MCP `check_translation`) и импорт готового перевода берут его, а не карту: смена карты в настройках ничего не ломает до `POST /reparse`. `POST /settings {format_map}` (карта целиком) возвращает `reparse` — сколько оригиналов разобрано не тем форматом; `GET /games/:slug` → `formats: [{ext, files, strings, format, parsed[]}]` (таблица в настройках, строка «форматы» на странице игры), `game.format_map` (MCP `get_game`).
- **Пересчёт** (`/reparse`) прогоняет все `source_files` через `importSource`: строки сопоставляются по `(file, key)`, утверждения остаются там, где ключ и `source_hash` совпали; строки файлов, ставших `"-"`, помечаются `removed` (утверждения хранятся и вернутся при обратной смене).
- **Двоичные и «как есть» файлы**: браузер (и `forum.mjs`) шлёт байтами в `data` (base64) файлы, которые похожи на двоичные (`looksBinary`: нулевой байт в первых 8 КБ, кроме UTF-16 с BOM), расширения с `"-"` и расширения, которых не знает ни один формат. Хранятся в `source_files.data` (bytea, `encoding = 'binary'`), не больше 3 МБ на файл (`RAW_MAX_BYTES`: тело запроса Vercel ~4.5 МБ, base64 +33%); загрузка идёт пачками по ~3 МБ. Выгрузка (`exportLanguage` → `OutFile.data`), zip на сайте, `export?binary=1`, релизы и `source/` в «Опубликовать» отдают их байт в байт; `export` без `binary` кладёт их байты в `data`. Двоичный файл с расширением, которому назначен текстовый формат, сохраняется как есть с ошибкой в `errors`.
- **Репо игры**: `game.json` может содержать `format_map` — при `/admin/import` он дополняет карту на форуме (записи из файла главнее), «Опубликовать» пишет в `game.json` текущую карту. Старое поле `format` по-прежнему принимается как формат по умолчанию.
- Миграция для существующих игр: `source_files.format = games.format`, карта — все расширения файлов игры → `games.format` (у Gunpoint: `{".gpc": "gunpoint"}`), так что строки, ключи и утверждения не меняются.

## Удаление оригиналов и корзина

Миграция `011_source_trash.sql`: `source_files_trash` (те же поля, что у `source_files`, + `deleted_by`, `deleted_at`). `deleteSource` (`src/sync.ts`) переносит строки `source_files` в корзину и помечает строки файла `removed` — как при пропаже файла из полной загрузки (`finalizeSource` теперь тоже кладёт пропавшие оригиналы в корзину). Варианты, голоса и утверждения не трогаются. `restoreSource` возвращает файл через `importSource` (формат — по текущей карте): строки с теми же `(file, key)` снова видны со своими утверждениями (если оригинал строки не менялся — не устаревшие). Пути, которые уже загружены заново, не перезаписываются (`skipped`). Записи старше 30 дней удаляются при следующем удалении. На сайте — панель «Оригинальные файлы» в настройках: фильтр, сортировка, выбор галочками, удаление с подтверждением в панели и «Отменить» в уведомлении (вызывает restore), список корзины.

## MCP: управление играми

Все инструменты вызывают тот же REST API от имени пользователя (права, баны и лимиты — как на сайте). Имена существующих инструментов не меняются (коннектор claude.ai кэширует список). Управление: `create_game` → `POST /games`; `update_game_info` (только переданные поля) → `POST /settings` и возвращает игру; `add_language` / `remove_language {force?}` — читают языки из `GET /games/:slug` и пишут список целиком; `set_format_map` → `POST /settings {format_map}`; `reparse_game`; `list_source_files` (только чтение); `upload_source_files {files: [{path, content | base64, encoding?}], replace?}` — не больше 3 МБ за вызов (иначе ошибка с просьбой разделить), `replace` передаёт пути вызова как полный набор; `delete_source_files` / `restore_source_files {paths}`. Тесты — `test/mcp.test.ts`.

## Публикация выбранных языков

`POST /api/games/:slug/publish/start {version?, langs, return}` — `langs` обязателен (непустой, подмножество языков игры) и едет в OAuth-state (JWT `typ: 'publish'`). `publishGame(game, token, {version, site, langs})` пишет коммит поверх текущего дерева репо: `source/`, `game.json`, `README.md` и только папки выбранных языков — остальные папки не трогаются. Релизы — только для выбранных языков; итог по каждому в `langs: [{lang, status: committed|released|exists|skipped|error, tag?, error?}]` (уже существующий тег одного языка не роняет публикацию остальных).

## Страница игры и «Об игре»

Миграция `007_game_info.sql`: `games.description` (до 5000 символов, показывается как обычный текст), `games.links` (jsonb, до 10 элементов `{kind: steam|site|gog|itch|other, url, title?}`), `games.cover_url`. Ссылки и обложка — только `http(s)://`, до 500 символов. Поля принимают `POST /api/games` и `POST /api/games/:slug/settings` (не передано — не меняется, пустое — очищается); отдают `GET /api/games/:slug` и `GET /api/games` (описание обрезано до 300 символов). Если обложки нет, а есть ссылка Steam, сайт сам подставляет `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/<appid>/header.jpg` (не cloudflare-CDN: он недоступен в части стран); сервер ничего не скачивает.

Языки: `settings {languages}` убирает язык, только если у него нет утверждённых переводов, иначе 422 — нужен `force: true` (переводы остаются в базе и вернутся при повторном добавлении). Маршрут сайта `#/g/:slug` — обзор игры, `#/g/:slug/:lang` — перевод.

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
