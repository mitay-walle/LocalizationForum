// README.md репозитория игры для игроков: как скачать и поставить перевод (Release, а не исходники репо).
// Генерируется при каждой публикации. Раздел на языке каждого перевода игры, для которого есть текст,
// плюс английский обзор всегда (он же покрывает английский и языки без своего текста). Текст детерминирован (без дат) — иначе каждая публикация давала бы новый коммит.
import type { Game } from './sync.js';

/** Плейсхолдеры: {title} {tag} {zip} {list} {latest} {forum} */
interface Texts {
  name: string;
  intro: string;
  install: string;
  steps: [string, string, string];
  warn: string;
  help: string;
}

const T: Record<string, Texts> = {
  ru: {
    name: 'Русский',
    intro: 'Русский перевод игры **{title}**, сделанный сообществом на LocalizationForum.',
    install: 'Как установить',
    steps: [
      'Откройте [релизы с этим переводом]({list}) и возьмите самый новый — его тег начинается с `{tag}` (например `{tag}1.0`). Ссылка «[последний релиз]({latest})» ведёт на самый свежий релиз репозитория, но он может оказаться на другом языке.',
      'В разделе **Assets** скачайте архив `{zip}`.',
      'Распакуйте архив прямо в папку игры с заменой файлов — структура папок в архиве такая же, как у оригинала.',
    ],
    warn: 'Не скачивайте исходники репозитория (**Code → Download ZIP** или «Source code»): там оригиналы и все языки сразу, это не готовый к установке перевод.',
    help: 'Нашли ошибку или хотите помочь? Переводите и голосуйте на форуме: {forum}',
  },
  uk: {
    name: 'Українська',
    intro: 'Український переклад гри **{title}**, зроблений спільнотою на LocalizationForum.',
    install: 'Як встановити',
    steps: [
      'Відкрийте [релізи з цим перекладом]({list}) і візьміть найновіший — його тег починається з `{tag}` (наприклад `{tag}1.0`). Посилання «[останній реліз]({latest})» веде на найсвіжіший реліз репозиторію, але він може бути іншою мовою.',
      'У розділі **Assets** завантажте архів `{zip}`.',
      'Розпакуйте архів просто в теку гри із заміною файлів — структура тек в архіві така сама, як в оригіналі.',
    ],
    warn: 'Не завантажуйте вихідний код репозиторію (**Code → Download ZIP** або «Source code»): там оригінали й усі мови одразу, це не готовий до встановлення переклад.',
    help: 'Знайшли помилку або хочете допомогти? Перекладайте й голосуйте на форумі: {forum}',
  },
  de: {
    name: 'Deutsch',
    intro: 'Deutsche Übersetzung von **{title}**, von der Community auf LocalizationForum erstellt.',
    install: 'Installation',
    steps: [
      'Öffne die [Releases mit dieser Übersetzung]({list}) und nimm das neueste — sein Tag beginnt mit `{tag}` (zum Beispiel `{tag}1.0`). Der Link „[neuestes Release]({latest})“ zeigt immer auf das neueste Release des Repositorys, das auch in einer anderen Sprache sein kann.',
      'Lade unter **Assets** das Archiv `{zip}` herunter.',
      'Entpacke es direkt in den Spielordner und ersetze dabei die Dateien — die Ordnerstruktur im Archiv entspricht dem Original.',
    ],
    warn: 'Lade nicht den Quellcode des Repositorys herunter (**Code → Download ZIP** oder „Source code“): Er enthält die Originale und alle Sprachen auf einmal und ist nicht installationsfertig.',
    help: 'Fehler gefunden oder Lust mitzuhelfen? Übersetze und stimme im Forum ab: {forum}',
  },
  es: {
    name: 'Español',
    intro: 'Traducción al español de **{title}**, hecha por la comunidad en LocalizationForum.',
    install: 'Cómo instalar',
    steps: [
      'Abre las [versiones con esta traducción]({list}) y elige la más reciente: su etiqueta empieza por `{tag}` (por ejemplo `{tag}1.0`). El enlace «[última versión]({latest})» siempre lleva a la versión más reciente del repositorio, que puede ser de otro idioma.',
      'En **Assets**, descarga el archivo `{zip}`.',
      'Descomprímelo directamente en la carpeta del juego, reemplazando los archivos: la estructura de carpetas del archivo es la misma que la del original.',
    ],
    warn: 'No descargues el código fuente del repositorio (**Code → Download ZIP** o «Source code»): contiene los originales y todos los idiomas a la vez y no está listo para instalar.',
    help: '¿Has encontrado un error o quieres ayudar? Traduce y vota en el foro: {forum}',
  },
  fr: {
    name: 'Français',
    intro: 'Traduction française de **{title}**, réalisée par la communauté sur LocalizationForum.',
    install: 'Installation',
    steps: [
      'Ouvrez les [versions de cette traduction]({list}) et prenez la plus récente : son tag commence par `{tag}` (par exemple `{tag}1.0`). Le lien « [dernière version]({latest}) » mène toujours à la version la plus récente du dépôt, qui peut être dans une autre langue.',
      'Dans **Assets**, téléchargez l’archive `{zip}`.',
      'Décompressez-la directement dans le dossier du jeu en remplaçant les fichiers : l’arborescence de l’archive est la même que celle du jeu original.',
    ],
    warn: 'Ne téléchargez pas le code source du dépôt (**Code → Download ZIP** ou « Source code ») : il contient les originaux et toutes les langues à la fois et n’est pas prêt à installer.',
    help: 'Vous avez trouvé une erreur ou voulez aider ? Traduisez et votez sur le forum : {forum}',
  },
  'pt-BR': {
    name: 'Português (Brasil)',
    intro: 'Tradução para o português de **{title}**, feita pela comunidade no LocalizationForum.',
    install: 'Como instalar',
    steps: [
      'Abra os [releases com esta tradução]({list}) e pegue o mais novo — a tag dele começa com `{tag}` (por exemplo `{tag}1.0`). O link “[release mais recente]({latest})” sempre aponta para o release mais novo do repositório, que pode ser de outro idioma.',
      'Em **Assets**, baixe o arquivo `{zip}`.',
      'Descompacte-o direto na pasta do jogo, substituindo os arquivos — a estrutura de pastas do arquivo é a mesma do original.',
    ],
    warn: 'Não baixe o código-fonte do repositório (**Code → Download ZIP** ou “Source code”): ele contém os originais e todos os idiomas de uma vez e não está pronto para instalar.',
    help: 'Encontrou um erro ou quer ajudar? Traduza e vote no fórum: {forum}',
  },
  pl: {
    name: 'Polski',
    intro: 'Polskie tłumaczenie gry **{title}**, przygotowane przez społeczność na LocalizationForum.',
    install: 'Jak zainstalować',
    steps: [
      'Otwórz [wydania z tym tłumaczeniem]({list}) i wybierz najnowsze — jego tag zaczyna się od `{tag}` (np. `{tag}1.0`). Link „[najnowsze wydanie]({latest})” zawsze prowadzi do najnowszego wydania repozytorium, które może być w innym języku.',
      'W sekcji **Assets** pobierz archiwum `{zip}`.',
      'Rozpakuj je bezpośrednio do folderu gry, zastępując pliki — struktura folderów w archiwum jest taka sama jak w oryginale.',
    ],
    warn: 'Nie pobieraj kodu źródłowego repozytorium (**Code → Download ZIP** ani „Source code”): zawiera oryginały i wszystkie języki naraz i nie nadaje się do instalacji.',
    help: 'Znalazłeś błąd albo chcesz pomóc? Tłumacz i głosuj na forum: {forum}',
  },
  zh: {
    name: '中文',
    intro: '**{title}** 的中文翻译，由社区在 LocalizationForum 上完成。',
    install: '安装方法',
    steps: [
      '打开[该译文的发布页]({list})，选择最新的一个 —— 其标签以 `{tag}` 开头（例如 `{tag}1.0`）。“[最新发布]({latest})”链接总是指向本仓库最新的发布，可能是其他语言的。',
      '在 **Assets** 中下载压缩包 `{zip}`。',
      '将压缩包直接解压到游戏文件夹并覆盖文件 —— 压缩包内的目录结构与原版游戏相同。',
    ],
    warn: '请不要下载仓库源代码（**Code → Download ZIP** 或 “Source code”）：其中同时包含原文和所有语言，不能直接安装。',
    help: '发现错误或想要帮忙？欢迎在论坛上翻译和投票：{forum}',
  },
  ja: {
    name: '日本語',
    intro: '**{title}** の日本語訳です。LocalizationForum でコミュニティが翻訳しました。',
    install: 'インストール方法',
    steps: [
      '[この翻訳のリリース一覧]({list})を開き、いちばん新しいものを選びます。タグは `{tag}` で始まります（例：`{tag}1.0`）。「[最新リリース]({latest})」のリンクはリポジトリ全体の最新リリースを指すため、別の言語の場合があります。',
      '**Assets** からアーカイブ `{zip}` をダウンロードします。',
      'ゲームのフォルダにそのまま展開し、ファイルを上書きします。アーカイブ内のフォルダ構成は元のゲームと同じです。',
    ],
    warn: 'リポジトリのソースコード（**Code → Download ZIP** や「Source code」）はダウンロードしないでください。原文とすべての言語が含まれており、そのままではインストールできません。',
    help: '誤りを見つけた、または手伝いたい場合は、フォーラムで翻訳・投票してください：{forum}',
  },
};

/** Текст на языке перевода: точное совпадение, затем по основной части кода (pt-PT → pt-BR); нет — null. */
function textsFor(lang: string): Texts | null {
  if (T[lang]) return T[lang];
  const base = lang.toLowerCase().split('-')[0];
  const key = Object.keys(T).find((k) => k.toLowerCase().split('-')[0] === base);
  return key ? T[key] : null;
}

const EN = {
  warn: 'Do not download the repository source (**Code → Download ZIP** or “Source code”): it contains the originals and all languages at once and is not ready to install.',
  help: 'Found a mistake or want to help? Translate and vote on the forum:',
};

const fill = (s: string, p: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k) => p[k] ?? m);

export function readme(game: Pick<Game, 'title' | 'slug' | 'repo' | 'source_lang' | 'languages'>, site: string): string {
  const repoUrl = `https://github.com/${game.repo}`;
  const releases = `${repoUrl}/releases`;
  const latest = `${releases}/latest`;
  const forumGame = `${site}#/g/${game.slug}`;
  const list = (lang: string) => `${releases}?q=${encodeURIComponent(lang + '-')}&expanded=true`;
  const zip = (lang: string) => `${game.slug}-${lang}-<version>.zip`;
  const nameOf = (lang: string) => (lang === 'en' ? 'English' : T[lang]?.name ?? lang);

  const section = (lang: string, x: Texts) => {
    const p = { title: game.title, tag: `${lang}-`, zip: zip(lang), list: list(lang), latest, forum: `${forumGame}/${lang}` };
    return [
      `## ${T[lang] ? x.name : `${x.name.replace(/ \(.*\)$/, '')} (\`${lang}\`)`}`,
      '',
      fill(x.intro, p),
      '',
      `### ${x.install}`,
      '',
      ...x.steps.map((s, i) => `${i + 1}. ${fill(s, p)}`),
      '',
      `> ${fill(x.warn, p)}`,
      '',
      fill(x.help, p),
    ].join('\n');
  };

  // Английский обзор — всегда: все языки и общая инструкция
  const overview = [
    '## English',
    '',
    `Community translations of **${game.title}** made on LocalizationForum:`,
    '',
    ...game.languages.map((l) => `- ${nameOf(l) === l ? `\`${l}\`` : `${nameOf(l)} (\`${l}\`)`} — [releases](${list(l)})`),
    '',
    '### How to install',
    '',
    `1. Open the releases of your language (links above) and take the newest one. Each release contains one language; its tag is \`<language>-<version>\`, for example \`${game.languages[0] ?? 'en'}-1.0\`. The [latest release](${latest}) link always points to the newest release of the repository, which may be in another language. [All releases](${releases}).`,
    `2. Under **Assets**, download the archive \`${game.slug}-<language>-<version>.zip\`.`,
    '3. Unpack it straight into the game folder, replacing files — the folders in the archive match the original game.',
    '',
    `> ${EN.warn}`,
    '',
    `${EN.help} ${forumGame}`,
  ].join('\n');

  const sections: string[] = [];
  for (const l of game.languages) {
    const x = l.toLowerCase().split('-')[0] === 'en' ? null : textsFor(l);
    if (x) sections.push(section(l, x));
  }
  sections.push(overview);

  return [
    `# ${game.title} — translations`,
    '',
    `**[Releases](${releases})** · **[LocalizationForum](${forumGame})**`,
    '',
    ...sections.flatMap((s) => [s, '']),
    '---',
    '',
    '## Repository layout',
    '',
    `- \`source/\` — original game files (${game.source_lang})`,
    ...game.languages.map((l) => `- \`${l}/\` — translation${nameOf(l) === l ? '' : ` (${nameOf(l)})`}, approved strings only; the same files are in the release zip`),
    '- `game.json` — game info for the forum',
    '',
    'This README and the files are generated by the forum’s “Publish to GitHub” button. Edit translations on the forum — direct changes here will be overwritten.',
    '',
  ].join('\n');
}
