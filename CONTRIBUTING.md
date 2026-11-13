# Contributing to Vertskim

Thank you for wanting to help. This guide says how to set the project up, what a good issue and a
good pull request look like, and, step by step, how to do the things people most often want to do:

| I want to… | Go to |
|---|---|
| Report a bug or a wrong answer | [Reporting an issue](#reporting-an-issue) |
| Fix a bug | [Fixing a bug](#fixing-a-bug) |
| Teach Vertskim a new programming language | [Adding a programming language](#adding-a-programming-language) |
| Change how the 3D view looks, or add a theme | [UI designs and themes](#ui-designs-and-themes) |
| Make something faster or smaller | [Optimizations](#optimizations) |
| Send my change | [Pull requests](#pull-requests) |

If you are unsure whether an idea fits, open an issue and ask before writing code. That costs you
five minutes and can save a weekend.

## What the project holds to

Four promises to the people who use Vertskim. A change that breaks one will not be merged, however
good it is otherwise.

1. **The project directory is only ever read.** Nothing is written inside it: no cache folder, no
   config file, no index. Everything Vertskim keeps goes to the user's data folder.
2. **Nothing leaves the machine** unless the user switched that on. No telemetry, no update
   checks, no models or grammars downloaded behind anyone's back.
3. **A guess is called a guess.** A relationship that was matched by name alone is marked as one
   (`confidence: "heuristic"`, shown as `~`). Never present a guess as a fact to make a number
   look better.
4. **Say what was tried.** The README and [KNOWN_ISSUES.md](KNOWN_ISSUES.md) state what has been
   measured and what has not. Keep them true when your change moves a number or a limit.

## Getting set up

You need [Node.js](https://nodejs.org) 22.16 or newer and git. There is nothing to compile: the
database is Node's own SQLite and the parsers are WebAssembly.

```bash
git clone https://github.com/MyKa322/Vertskim.git
cd Vertskim
npm install
npm run build
npm test
```

`npm test` builds first, then runs every test with Node's own test runner. It needs no browser.

| Command | Does |
|---|---|
| `npm run build` | Type-checks and builds every package, and the 3D view |
| `npm test` | Builds, then runs all tests |
| `npm run test:browser` | Drives the 3D view in Chromium (run `npx playwright install chromium` once) |
| `npm run lint` | Checks code and formatting with [Biome](https://biomejs.dev) |
| `npm run format` | Formats the code |
| `npm run vertskim -- <command>` | Runs your build of the command line on this repository |
| `node packages/cli/dist/bin.js --root <dir> <command>` | Runs it on any other project |

To run one test file, build and then name it:

```bash
npm run build
node --test packages/core/dist/languages.test.js
```

### Where things are

```
packages/core    the engine: walking, parsing, resolving, the SQLite store, the watcher, analysis
  src/discovery    which files exist and what each one is
  src/extract      tree-sitter queries, one file per language under languages/
  src/resolve      turning names into edges: imports, calls, types
  src/store        the graph in SQLite
  src/query, src/analyze   what the tools ask of the graph
  src/scip, src/embed      the two optional extras
packages/mcp     the ten MCP tools, their text output and token budgets, the benchmark
packages/server  the local HTTP server behind the 3D view
packages/ui      the 3D view: React, three.js, 3d-force-graph
packages/cli     the `vertskim` command
fixtures/        small projects the tests index: sample (TypeScript, Python, Markdown),
                 polyglot (one per other language), aliases (import aliases)
bench/           questions with known answers, and the measurements behind the README's charts
docs/media/      screenshots, demo and charts for the README
scripts/         build helpers and the scripts that make docs/media
```

Vertskim can map itself, which is the quickest way to find your way round:

```bash
npm run vertskim -- overview
npm run vertskim -- search "resolve import"
npm run vertskim -- impact "packages/core/src/store/store.ts#GraphStore.addEdge"
npm run vertskim -- ui
```

## Reporting an issue

Search the [existing issues](https://github.com/MyKa322/Vertskim/issues) and
[KNOWN_ISSUES.md](KNOWN_ISSUES.md) first: the limit you hit may be a known one.

A report that can be acted on has:

- **What you ran and what came back**, copied as text: the command or the tool call, and the
  output.
- **What you expected instead.**
- **The versions:** `vertskim --version`, `node --version`, and your operating system.
- **The output of `vertskim status`** for the project. It shows how big the index is, where it
  lives, and any file that did not parse.

For a **wrong or missing relationship** (the most useful kind of report), the smallest source that
shows it is worth more than any description. Two or three short files are usually enough:

````markdown
`a.ts`
```ts
export class Store { refresh() {} }
```
`b.ts`
```ts
import { Store } from "./a";
export function run(store: Store) { store.refresh(); }
```
`vertskim neighbors "a.ts#Store.refresh" --in` lists nothing; I expected `b.ts#run`.
````

Please do not paste code you are not allowed to share. Reduce it to a made-up example that shows
the same thing.

**Security problems** (anything that lets Vertskim write outside its data folder, send data off
the machine, or let another program read a project through the local server) should not go in a
public issue. Report them privately through "Report a vulnerability" on the repository's Security
tab.

## Fixing a bug

1. **Reproduce it in a test first.** Most bugs are a wrong or missing node or edge, and the tests
   for those all look alike: index a fixture, then assert on what is in the graph.

   ```ts
   test("a call through a typed parameter reaches the method", () => {
     resolved("b.ts#run", "calls", "a.ts#Store.refresh");
   });
   ```

   `packages/core/src/languages.test.ts` (one test per language over `fixtures/polyglot`) and
   `packages/core/src/edges.test.ts` are good models. The helpers in
   `packages/core/src/testing/helpers.ts` copy a fixture to a temporary folder (`copyFixture`),
   write files into it (`write`) and look an edge up (`edge`).
2. **Add to a fixture rather than making a new one** when the case fits an existing project under
   `fixtures/`. Keep fixture code small and readable: it is documentation of what is supported.
3. **Fix it, and watch the test pass.** Run the whole suite as well: a change to resolving in one
   language easily moves an edge in another.
4. **If extraction output changed** (other nodes, other signatures, other raw references), bump
   `EXTRACTOR_VERSION` in `packages/core/src/extract/index.ts`. Existing databases are then
   re-indexed instead of mixing old and new output.
5. **If the bug is listed in [KNOWN_ISSUES.md](KNOWN_ISSUES.md)**, update its entry in the same
   pull request.

A fix for a wrong guess should make the guess right or remove it. It should not hide the `~`.

## Adding a programming language

Everything language-specific lives in one file that exports a `LanguageSpec`: a tree-sitter query
that uses shared capture names, plus a few small functions for what a query cannot say. The engine
(`extract/engine.ts`) and the resolver do the rest, the same way for every language.
`packages/core/src/extract/languages/go.ts` is the shortest complete example (about 280 lines);
`packages/core/src/extract/spec.ts` documents every field.

### 1. Check that a grammar exists

Vertskim loads grammars as WebAssembly from the
[`@vscode/tree-sitter-wasm`](https://github.com/microsoft/vscode-tree-sitter-wasm) package. After
`npm install`, list what it ships:

```bash
ls node_modules/@vscode/tree-sitter-wasm/wasm/
```

At the time of writing that is bash, c-sharp, cpp, css, go, ini, java, javascript, php, powershell,
python, regex, ruby, rust, tsx and typescript. Luau and Lua use a separately vendored grammar;
its source, version, checksum and licence are recorded in
[`packages/core/grammars/README.md`](packages/core/grammars/README.md).
If your language is there, carry on. If it is not (Kotlin, Swift, Dart…), the grammar has to come from somewhere else, and
`packages/core/src/extract/runtime.ts` has to learn to find it. **Open an issue first**: where
grammars come from is a decision about dependencies, and it is better made once than per language.

### 2. Tell Vertskim which files are that language

In `packages/core/src/discovery/classify.ts`:

- add the extensions to `LANGUAGE_BY_EXT` (many languages are already there, as labels without a
  parser);
- make sure the label is in `SOURCE_LANGUAGES`;
- if test files follow a naming convention of their own (`_test.go`, `FooTest.java`), add it to
  `TEST_FILE` or `TEST_CLASS_FILE`, and to the test at the bottom of `languages.test.ts`.

### 3. Write the spec

Create `packages/core/src/extract/languages/<language>.ts`. The skeleton:

```ts
import type { LanguageSpec } from "../spec.js";
import { commentAbove, signatureBeforeBody } from "./common.js";

const QUERY = `
(function_declaration name: (identifier) @name) @def.function
(class_declaration name: (identifier) @name) @def.class
(method_declaration name: (identifier) @name) @def.method

(call_expression function: (identifier) @name) @ref.call
(call_expression function: (member_expression object: (_) @qualifier property: (identifier) @name)) @ref.call

(import_declaration) @import
(identifier) @ref.ident
`;

export const mylang: LanguageSpec = {
  id: "mylang",            // the label from classify.ts
  grammar: "mylang",       // loads tree-sitter-mylang.wasm
  family: "mylang",        // languages of one family can call each other (c and cpp, js and ts)
  query: QUERY,
  scopeBreakers: new Set(["block"]),   // node types inside which definitions are not indexed
  selfNames: new Set(["this"]),        // receivers that mean "the enclosing class"
  importsAreExports: false,
  classify,       // accept or reject a matched definition, and settle its kind
  outer,          // the outermost node of a definition (export wrapper, decorators)
  exported,       // is it visible outside its file?
  signature,      // the one-line signature shown to the assistant
  doc,            // its doc comment
  isIdentUsage,   // false when an identifier is a declaration, not a use
  parseImport,    // an @import node -> what is imported, under which names
  resolveImport,  // an import -> project files, or a third-party module (ext:<ecosystem>/<name>)
};
```

The capture names the engine understands:

| Capture | Means |
|---|---|
| `@def.<kind>` with `@name` | A definition. `<kind>` is yours to choose; `classify` turns it into a node kind (`class`, `interface`, `function`, `method`, `variable`, `type`) |
| `@ref.call`, `@ref.new` | A call or construction, with `@name` and an optional `@qualifier` (what is written before the dot) |
| `@ref.extends`, `@ref.implements` | Inheritance, with `@name`, optional `@qualifier`, optional `@subject` |
| `@ref.type` | A type name used in an annotation |
| `@ref.ident` | Any identifier; kept only if it names an import or a file-level symbol |
| `@import` | An import statement, handed to `parseImport` |
| `@var` with `@vartype` | A variable, parameter or field and its declared type: this is what lets `value.method()` find the right class |
| `@newtype`, `@varcall`, `@varvalue` | Instead of `@vartype`: the class a variable is constructed from, the call whose result it holds, another value it is set to |
| `@scan` | A node your `scanCalls` reads more calls from (a Rust macro's tokens, say) |

`spec.ts` lists the rest, and the optional hooks for languages that need them: `packageOf` and
`ambient` (files in scope without an import, as in Go, Java and C#), `resolveQualifier`
(`crate::a::b`), `implicitSelf`, `prototypes` (C headers), `globalTypes` (Ruby), `reparse`.

Advice from the languages already done:

- **Start with definitions only** and look at the outline of a real file (`vertskim node <file>`).
  Add calls, then imports, then typed variables, checking each step.
- **To see what the grammar calls things**, paste code into the
  [tree-sitter playground](https://tree-sitter.github.io/tree-sitter/7-playground.html), or read
  the grammar's `node-types.json`.
- **Typed variables are where accuracy comes from.** Every `@var`/`@vartype` pair you capture turns
  name-only guesses into resolved calls.
- **List the standard library's most common method names** in `commonMembers` (Java's `getName`,
  Ruby's `each`), and its global objects in `globals`. Matching those by name alone says nothing,
  and leaving them out removed hundreds of wrong guesses in the languages already done.
- **Reuse `common.ts`**: `commentAbove`, `signatureBeforeBody`, `unquote`, `ancestor`.

### 4. Register it

In `packages/core/src/extract/index.ts`, import the spec, add it to `SPECS`, and bump
`EXTRACTOR_VERSION`.

Then give the language its names where output is formatted. None of these stops it working, but
all show:

| File | What to add |
|---|---|
| `packages/ui/src/ui/Inspector.tsx` (`LANGUAGES`) | The language's display name |
| `packages/ui/src/highlight.ts` (`BY_LANGUAGE`) | Which syntax-highlighting rules its source uses |
| `packages/ui/src/fileIcons.ts` | Its file icon (see the [icons' README](packages/ui/src/icons/README.md)) |
| `packages/mcp/src/format.ts` (`LANGUAGE_SHORT`) | A short label for tool output, if the full one is long |

### 5. Add a fixture and a test

Create `fixtures/polyglot/<language>/`: a tiny, believable project of four to eight files that
uses the language the way it is really written. It should contain at least:

- two files where one imports the other, by the language's normal mechanism;
- a class (or the nearest thing) with methods, and a subclass or an implemented interface;
- a call through a typed variable or parameter, and a call on `this` or `self`;
- a doc comment, an exported and a non-exported symbol;
- a test file, named the way the language names them;
- one third-party import.

Then add a test to `packages/core/src/languages.test.ts` that asserts, by id, on the nodes and
edges that only come out right if the language's rules are followed:

```ts
test("MyLang: modules are files, typed parameters settle calls", () => {
  const shop = "mylang/src/shop";
  assert.equal(node(`${shop}/cart.ml#Cart`)?.kind, "class");
  assert.equal(node(`${shop}/cart.ml#Cart.total`)?.exported, 1);
  resolved(`${shop}/main.ml#run`, "calls", `${shop}/cart.ml#Cart.total`);
  resolved(`${shop}/cart.ml#Cart`, "extends", `${shop}/base.ml#Container`);
});
```

Add your language to the "languages keep to themselves" test too: a name that exists in two
languages must not be linked across them.

### 6. Try it on a real project

Fixtures prove the rules; real code finds what you did not think of. Shallow-clone a well-known
open-source project of a few hundred files **outside** the repository, index it, and report in the
pull request:

```bash
node packages/cli/dist/bin.js --root /path/to/clone index --rebuild
node packages/cli/dist/bin.js --root /path/to/clone status
```

- how many files there are and how long the first index took;
- how many files did not parse (`status` lists them), and why, if you can tell;
- how many calls were resolved and how many are guesses. The index is a SQLite file, `graph.db`, in
  the data folder `status` prints, and this counts its edges by kind and confidence:

  ```bash
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});console.table(db.prepare('select kind, confidence, count(*) as edges from edges group by kind, confidence').all())" /path/to/data/folder/graph.db
  ```

  (`heuristic` is a guess; `resolved` and `exact` are not);
- **a sample read by hand:** pick eight to ten edges at random, half of them guesses, open the
  source, and say how many are right.

[KNOWN_ISSUES.md](KNOWN_ISSUES.md#eight-outside-projects-n5) shows what this looked like for the
last eight languages.

### 7. Document it

Add the language to the table and to the limits in the README, with what it was tried on, and
write down what does not work: every language so far has such a list, and saying so is part of the
feature.

## UI designs and themes

The 3D view is a React page (`packages/ui`) round a three.js scene, built by Vite into static
files that `packages/server` serves.

### Working on the page

Run the server on any project, and Vite beside it:

```bash
node packages/cli/dist/bin.js --root . ui --no-open --port 4517
```

```bash
npm run dev -w @vertskim/ui
```

Open the address Vite prints, adding the `/?t=…` part of the link the first command printed (the
access key).
Vite reloads the page as you edit and forwards `/api` to the server. The built page is what users
get, so check it too before you send the change: `npm run build`, then `vertskim ui`.

### Where the look is decided

| What | Where |
|---|---|
| Colours of the page: panels, text, borders, syntax highlighting | CSS custom properties at the top of `packages/ui/src/styles.css`, each written once as `light-dark(<light>, <dark>)` |
| Colours of the scene: one per kind of node and edge, the folder palette, selection, background | `packages/ui/src/theme.ts` (`KIND_COLORS`, `EDGE_COLORS`, `FOLDER_PALETTE`, `SELECTION`, `BACKGROUND`…) |
| Shapes and materials of nodes, links, labels, the backdrop and the glow | `packages/ui/src/graph/` (`bodies.ts`, `links.ts`, `labels.ts`, `backdrop.ts`, `markers.ts`) |
| Layout: title bar, activity bar, explorer, tabs, inspector, status bar | `packages/ui/src/ui/`, put together in `App.tsx` |
| The theme menu | `ThemeMenu` in `packages/ui/src/ui/ActivityBar.tsx` |
| What is remembered between visits | `packages/ui/src/prefs.ts` and `theme.ts` (in the browser's local storage only) |
| File and folder icons | `packages/ui/src/icons/` and `fileIcons.ts` |

### Changing colours, or adding a theme

Today the page has two appearances, dark and light, and a third choice that follows the system.

**To restyle an existing appearance**, change the values: the `light-dark()` pairs in `styles.css`
for the page, the two halves of each `LIGHT ? … : …` in `theme.ts` for the scene. The scene bakes
its colours into materials when it is built, which is why changing the theme reloads the page.

**To add a named theme** (a high-contrast one, say), the steps are:

1. Add the name to `ThemeChoice` in `theme.ts` and to `THEMES` in `ActivityBar.tsx`, and store it
   the way `chooseTheme` stores `dark` and `light`.
2. Give the scene its palette. `theme.ts` and the files in `graph/` choose between two sets of
   values with the `LIGHT` constant; a third theme means turning those pairs into one palette
   object per theme and reading from the current one. Do that refactor as its own commit, with no
   visual change, before adding the new colours.
3. Give the page its palette: a `:root[data-theme="<name>"]` block in `styles.css` that redefines
   the custom properties, and sets `color-scheme` to the ground it sits on.
4. Add a browser test beside "follows the system's choice of light or dark" in
   `packages/server/src/ui.browser.ts`.

Please open an issue with a mock-up or a screenshot before a large redesign. Taste differs, and
agreeing on the direction first is kinder to everyone's time.

### What a design change has to keep

- **Both appearances work.** Every colour you add needs a light and a dark value.
- **Text is readable**: a contrast of at least 4.5 to 1 against its background, 3 to 1 for large
  text and for the marks in the graph.
- **Kinds are not told apart by hue alone.** Classes, functions and so on also differ by the letter
  on their badge and by shape; keep a second cue for anything new, so the view works for people
  who see colours differently.
- **Keyboard and screen readers.** Controls are real buttons with labels (the browser tests find
  them by role and name). Keep focus visible, and keep everything but flying the camera reachable
  from the keyboard.
- **No outside resources.** The page's content security policy refuses scripts, fonts, styles and
  images from other hosts, and `eval`. Fonts come from the system; anything else ships in the
  build.
- **Icons need a licence that allows it.** The bundled ones are CC BY-SA 4.0 from vscode-icons and
  are credited in `packages/ui/src/icons/README.md` and `NOTICE`. Add yours there, with their
  source and licence.
- **The page stays light.** The build prints the size of each chunk; say in the pull request if
  one grew noticeably.

### Showing the change

Run the browser tests, and put before-and-after screenshots in the pull request. This takes the
same pictures the README uses, into a folder of your choice:

```bash
npx playwright install chromium
npm run media -- --out ../vertskim-shots --only shots
```

If your change alters what the README's pictures show, retake them (`npm run media`, which also
needs `ffmpeg` for the GIF) and commit the new files in `docs/media/`.

## Optimizations

Speed-ups and size reductions are welcome, with two conditions: **measure**, and **change nothing
else**.

1. **Measure before and after, on the same machine, more than once.** Report the median of at
   least three runs, and what you ran on. Useful yardsticks:

   | What | How |
   |---|---|
   | First index of a project | `vertskim --root <dir> --data-dir <empty temp dir> index`, which prints the time. `node_modules/three` is a handy 1,269-file JavaScript project that is already on your disk |
   | An update after one edit | `vertskim watch`, then save a file: each update prints how many files were re-linked and how long it took |
   | Size of tool output | `vertskim bench` |
   | Memory | `node --expose-gc`, or the process's peak memory as your system reports it |
   | Size of the page | The chunk sizes `npm run build` prints |

2. **Show that answers did not change.** The whole suite must pass, and for a change to indexing
   or resolving, the graph of a real project should be the same before and after: the node and
   edge counts that `vertskim index --rebuild` prints, and, where you have a compiler index,
   `vertskim bench --scip <file>`. `vertskim bench --questions bench/questions.json` scores search
   and context against 34 questions with known answers. If your change trades a little accuracy
   for a lot of speed, say so plainly and let the reviewers weigh it. Do not let it pass
   unnoticed.
3. **Keep it readable.** A clever loop needs a comment that says why it is the way it is, and the
   number that justified it.
4. **Mind the caches.** Anything worked out once per run and shared (`ResolveContext.memo`) has to
   be invalidated when a file changes. The test "changes are picked up without re-linking
   everything" guards the watcher's promise that an edit re-links only what it can affect.

Where the time and memory go today is written down in
[KNOWN_ISSUES.md](KNOWN_ISSUES.md) under R2: parsing runs on the server's main thread, vectors are
held in memory, and the 3D view is built from a copy of the whole graph. Those are the places
where an optimization would matter most.

If your change moves a number the README states, update [bench/results.json](bench/results.json)
and run `npm run charts` (add `-- --measure` to re-run the token benchmark).

## Code style

- **TypeScript, strict, ES modules.** `npm run lint` must pass; `npm run format` fixes formatting
  (two spaces, double quotes, semicolons, 120 columns).
- **Few dependencies.** The engine has two runtime dependencies, an optional file watcher, and
  nothing to compile. A new one
  needs a reason in the pull request; a native module needs a very good one.
- **Comments say why, not what.** Most functions here carry one sentence about what they are for.
  Match that.
- **Text for users is plain.** Error messages say what happened and what to do. Tool output is
  written for a reader who pays per token.
- **Tests use `node:test` and `node:assert`**, live beside the code as `*.test.ts`, and name the
  behaviour they check in a full sentence.
- **Docs use British spelling** (colour, licence). Please keep to it rather than mixing.

## Pull requests

1. **Fork** the repository and create a branch from `main` with a name that says what it does
   (`ruby-attr-reader`, `fix-go-embedded-receiver`).
2. **Keep it to one thing.** A bug fix and an unrelated refactor are two pull requests. Formatting
   changes to lines you did not otherwise touch make a change hard to review.
3. **Write commit messages in the imperative**, a short first line and then why:
   `Resolve Go calls through embedded structs`.
4. **Before you push**, run:

   ```bash
   npm run lint
   npm test
   ```

   and, if you touched `packages/ui` or `packages/server`, `npm run test:browser`.
5. **Open the pull request** against `main` and fill in the template. Say what the change does,
   why, and how you checked it. Link the issue it closes.
6. **CI** runs lint and tests on Linux, Windows and macOS with Node 22.16, 24 and 26, and the
   browser tests on Linux. It has to be green.
7. **Review.** Expect questions and requests for changes; that is the normal course, not a
   rejection. Push further commits to the same branch rather than force-pushing over a review in
   progress.

### Checklist

- [ ] `npm run lint` and `npm test` pass
- [ ] New behaviour has a test; a fixed bug has a test that failed before
- [ ] `EXTRACTOR_VERSION` is bumped if extraction output changed
- [ ] README and KNOWN_ISSUES.md are still true
- [ ] A new language: fixture, test, a trial on a real project with its numbers
- [ ] A UI change: `npm run test:browser` passes; before-and-after screenshots attached
- [ ] An optimization: before-and-after numbers, and evidence that answers did not change
- [ ] Files copied or adapted from elsewhere are named, with their source and licence

## Licence of contributions

Vertskim is licensed under the [Apache License 2.0](LICENSE). By sending a pull request you agree
that your contribution is licensed under the same terms (section 5 of the licence), and you
confirm that you wrote it or have the right to submit it. You keep the copyright to what you
wrote.

Do not copy code from projects whose licence does not allow it. If you adapt something from
another open-source project, say where it came from in the pull request and keep its notices; it
is then credited in [NOTICE](NOTICE).

Contributors are credited in the git history and in the release notes.
