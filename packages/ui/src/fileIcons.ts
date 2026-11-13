import { LIGHT } from "./theme";

/**
 * Which picture a file or a folder gets. The pictures are those of vscode-icons (see
 * `icons/README.md` for their licence); the rules here follow that project's own, cut
 * down to the names a codebase usually holds.
 */

// Bundled as text into one file of their own, so the page asks for them once.
const sources = import.meta.glob<string>("./icons/*.svg", { eager: true, query: "?raw", import: "default" });
const SVG = new Map<string, string>();
for (const [path, text] of Object.entries(sources)) SVG.set(path.slice(path.lastIndexOf("/") + 1, -4), text);

const urls = new Map<string, string>();

/** An address an `<img>` can show for the named icon. A few icons have a version for light grounds. */
function urlOf(name: string): string {
  const light = name.replace(/^(file|folder)_type_/, "$1_type_light_");
  const key = LIGHT && SVG.has(light) ? light : SVG.has(name) ? name : "default_file";
  let url = urls.get(key);
  if (url === undefined) {
    url = URL.createObjectURL(new Blob([SVG.get(key) ?? ""], { type: "image/svg+xml" }));
    urls.set(key, url);
  }
  return url;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** `icon: names…`, one icon per line, turned into name -> icon. */
function table(lines: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    for (const name of words(line.slice(colon + 1))) out.set(name, line.slice(0, colon).trim());
  }
  return out;
}

const FILE_NAMES = table(`
  npm: package.json package-lock.json .npmrc .npmignore
  node: .nvmrc .node-version
  yarn: yarn.lock .yarnrc .yarnrc.yml
  pnpm: pnpm-lock.yaml pnpm-workspace.yaml
  bun: bun.lock bun.lockb bunfig.toml
  deno: deno.json deno.jsonc deno.lock
  tsconfig: tsconfig.json
  jsconfig: jsconfig.json
  biome: biome.json biome.jsonc
  docker: dockerfile .dockerignore docker-compose.yml docker-compose.yaml compose.yml compose.yaml
  license: license license.md license.txt licence licence.md copying notice unlicense
  readme: readme readme.md readme.txt readme.rst
  git: .gitignore .gitattributes .gitmodules .gitkeep .mailmap
  editorconfig: .editorconfig
  dotenv: .env .env.local .env.example .env.development .env.production .env.test
  cargo: cargo.toml cargo.lock
  go_package: go.mod go.sum
  go_work: go.work go.work.sum
  maven: pom.xml
  gradle: build.gradle settings.gradle build.gradle.kts settings.gradle.kts gradlew gradlew.bat gradle.properties
  cmake: cmakelists.txt
  ruby: gemfile gemfile.lock .ruby-version
  rake: rakefile
  rubocop: .rubocop.yml
  pip: requirements.txt requirements-dev.txt pipfile pipfile.lock
  poetry: poetry.lock
  uv: uv.lock
  pytest: pytest.ini conftest.py
  python: pyproject.toml setup.py setup.cfg
  eslint: .eslintrc .eslintrc.js .eslintrc.cjs .eslintrc.json .eslintrc.yml .eslintignore
  prettier: .prettierrc .prettierrc.js .prettierrc.json .prettierrc.yml .prettierignore
  nginx: nginx.conf
  claude: claude.md
  agents: agents.md
  mcp: .mcp.json mcp.json
  config: makefile .browserslistrc
`);

/** Names such as `vite.config.ts`, whatever the extension. */
const FILE_STEMS = table(`
  vite: vite.config
  vitest: vitest.config vitest.workspace
  webpack: webpack.config
  rollup: rollup.config
  jest: jest.config
  playwright: playwright.config
  eslint: eslint.config
  prettier: prettier.config
`);

const FILE_SUFFIXES: [string, string][] = [
  [".d.ts", "typescriptdef"],
  [".d.mts", "typescriptdef"],
  [".d.cts", "typescriptdef"],
  [".test.ts", "testts"],
  [".spec.ts", "testts"],
  [".test.tsx", "testts"],
  [".spec.tsx", "testts"],
  [".test.js", "testjs"],
  [".spec.js", "testjs"],
  [".test.jsx", "testjs"],
  [".spec.jsx", "testjs"],
  [".test.mjs", "testjs"],
  [".js.map", "jsmap"],
  [".css.map", "jsmap"],
];

const FILE_EXTENSIONS = table(`
  typescript: ts mts cts
  reactts: tsx
  js: js mjs cjs
  reactjs: jsx
  python: py pyw
  pytyped: pyi
  jupyter: ipynb
  markdown: md markdown
  mdx: mdx
  go: go
  rust: rs
  java: java
  jar: jar war
  class: class
  kotlin: kt kts
  csharp: cs
  csproj: csproj
  sln: sln
  c: c
  cheader: h
  cpp: cpp cc cxx
  cppheader: hpp hh hxx
  cmake: cmake
  ruby: rb erb gemspec
  php: php
  json: json jsonc
  json5: json5
  yaml: yaml yml
  toml: toml
  xml: xml xsd
  ini: ini cfg properties
  config: conf lock
  dotenv: env
  html: html htm
  css: css
  scss: scss
  sass: sass
  less: less
  vue: vue
  svelte: svelte
  shell: sh bash zsh fish
  powershell: ps1 psm1 psd1
  bat: bat cmd
  sql: sql
  sqlite: sqlite sqlite3
  db: db
  swift: swift
  lua: lua
  svg: svg
  image: png jpg jpeg gif webp avif bmp ico tiff
  font: woff woff2 ttf otf eot
  audio: mp3 wav ogg flac
  video: mp4 webm mov
  pdf: pdf
  zip: zip tar gz tgz 7z rar
  binary: exe dll so dylib bin o
  csv: csv tsv
  text: txt rst adoc
  log: log
  graphql: graphql gql
  protobuf: proto
  terraform: tf tfvars
  wasm: wasm wat
`);

/** For a file whose name says nothing: the language the indexer read it as. */
const LANGUAGES = table(`
  typescript: typescript
  reactts: tsx
  js: javascript
  python: python
  markdown: markdown
  go: go
  rust: rust
  java: java
  kotlin: kotlin
  csharp: csharp
  c: c
  cpp: cpp
  ruby: ruby
  php: php
  swift: swift
  lua: lua
  shell: shell
  powershell: powershell
  sql: sql
  css: css
  scss: scss
  html: html
  vue: vue
  svelte: svelte
  json: json
  yaml: yaml
  toml: toml
`);

const FOLDER_NAMES = table(`
  src: src source sources
  test: test tests __tests__ spec specs testing
  docs: docs doc documentation
  node: node_modules
  github: .github
  vscode: .vscode
  dist: dist build out output release target
  script: scripts script
  package: packages package pkg
  component: components component widgets
  public: public
  asset: assets asset static resources res
  images: images image img icons pictures
  css: css
  style: styles style
  library: lib libs library vendor
  helper: utils util utilities helpers helper
  config: config configs configuration conf settings
  api: api apis
  app: app apps application
  binary: bin
  server: server backend
  client: client frontend
  cli: cli cmd commands
  typings: types typings @types
  model: models model entities
  view: views view pages screens ui
  controller: controllers controller
  services: services service
  hook: hooks hook
  tools: tools tool tooling
  template: templates template
  mock: mocks mock __mocks__ fixtures fixture stubs
  e2e: e2e
  git: .git
  temp: temp tmp
  www: www web site
  db: db database data migrations sql store
  plugin: plugins plugin extensions
  middleware: middleware middlewares
  locale: locale locales i18n lang translations
  log: logs log
  include: include includes headers
  common: common core
  shared: shared
  module: modules module
  python: python py
  typescript: typescript ts
  js: js javascript
  json: json
  docker: docker .docker
  coverage: coverage
  theme: themes theme
  fonts: fonts font
  audio: audio sounds
  video: video videos
  route: routes route router routing
  schema: schema schemas
  auth: auth authentication
  interfaces: interfaces interface
  private: private
  story: stories story
  gradle: gradle .gradle
  android: android
  ios: ios
  claude: .claude
  cursor: .cursor
  husky: .husky
  devcontainer: .devcontainer
  idea: .idea
  php: php
  lua: lua
  kotlin: kotlin
  redux: redux stores state
  notebooks: notebooks
  pytest: .pytest_cache
  kubernetes: k8s kubernetes
`);

function baseName(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function fileIconName(path: string, language?: string | null): string {
  const name = baseName(path).toLowerCase();
  const exact = FILE_NAMES.get(name);
  if (exact) return exact;
  if (/^tsconfig\..+\.json$/.test(name)) return "tsconfig";
  if (/^dockerfile\./.test(name) || name.endsWith(".dockerfile")) return "docker";
  if (/^\.env\./.test(name)) return "dotenv";
  const firstDot = name.indexOf(".", 1);
  if (firstDot > 0) {
    // `vite.config.ts`: everything before the last extension
    const stem = FILE_STEMS.get(name.slice(0, name.lastIndexOf(".")));
    if (stem) return stem;
  }
  for (const [suffix, icon] of FILE_SUFFIXES) if (name.endsWith(suffix)) return icon;
  const dot = name.lastIndexOf(".");
  const byExtension = dot >= 0 ? FILE_EXTENSIONS.get(name.slice(dot + 1)) : undefined;
  if (byExtension) return byExtension;
  return (language && LANGUAGES.get(language)) || "";
}

/** The icon for a file, from its name first and the language it was read as second. */
export function fileIcon(path: string, language?: string | null): string {
  const name = fileIconName(path, language);
  return urlOf(name ? `file_type_${name}` : "default_file");
}

/** The icon for a folder, closed or open. The project's own root has one of its own. */
export function folderIcon(path: string, open: boolean): string {
  const tail = open ? "_opened" : "";
  if (path === "./" || path === "") return urlOf(`default_root_folder${tail}`);
  const named = FOLDER_NAMES.get(baseName(path).toLowerCase());
  const specific = named ? `folder_type_${named}${tail}` : "";
  return urlOf(specific && SVG.has(specific) ? specific : `default_folder${tail}`);
}
