# Known issues

Status on 13 November 2026, including local fixes on top of commit `3e0971e`. The first
version of this list described `73ff893` itself; each item below now says what was done about it,
what that changed where it could be measured, and what is still open.

**Severity** (as first assessed): **High** puts wrong information in the graph, leaves out a lot,
or fails one of the project's stated goals. **Medium** is wrong or missing under likely
conditions, or blocks a step such as publishing. **Low** is rare, cosmetic, or affects only
people working on Vertskim.

**Status:** **Fixed**, **Improved** (better, with a measurable gap left), **Partly fixed** (some
of it done), **Open**, or **Your call** (waiting for a decision only you can make).

**Measurements**, all on Windows 11:

- a `scip-typescript` 0.6.2 index of this repository, compared with what syntax alone finds
  (`vertskim bench --scip`);
- 34 questions about this repository with known answers (`bench/questions.json`,
  `vertskim bench --questions`);
- first indexes of `node_modules/three` and of all of `node_modules`, read-only;
- eight open-source projects in Go, Rust, Java, C#, C++, C, Ruby and PHP, shallow-cloned outside
  the repository and only read;
- `Sleitnick/RbxUtil`, including 69 Luau files, with no parse errors and a ten-call source audit
  ([details](docs/luau-validation.md));
- a real MCP client: Claude Code (`claude -p`) working on this repository through Vertskim;
- the current test suite (148 tests) on Node 26.12, 24.0 and 22.16, also with the temporary
  directory behind a junction, and `npm run lint`. Browser validation is recorded in the
  [Luau validation notes](docs/luau-validation.md).

CI additionally passed all nine Linux/Windows/macOS jobs with Node 22.16, 24 and 26 at
`40a0695`, including all eight Chromium browser tests on Linux
([run](https://github.com/MyKa322/Vertskim/actions/runs/43472522658)).

## Summary

| ID  | Issue                                                                       | Severity | Status       |
| --- | --------------------------------------------------------------------------- | -------- | ------------ |
| A1  | Name-only guesses are wrong about one time in seven                         | High     | Fixed        |
| A2  | Methods of inline types become members of the enclosing class or interface  | Medium   | Fixed        |
| A3  | One syntax error removes every symbol in the file, silently                 | High     | Fixed        |
| A4  | Calls through variables, parameters and fields are mostly missed            | High     | Fixed        |
| A5  | Nested functions and object-literal methods are not nodes                   | Medium   | Fixed        |
| A6  | Nothing measures whether answers are right                                  | Medium   | Fixed        |
| A7  | Import aliases are treated as third-party packages                          | High     | Fixed        |
| A8  | Tasks described in plain words get weak starting points                     | Medium   | Improved     |
| A9  | Search by meaning finds the right code about two times in three             | Medium   | Improved     |
| A10 | Two shortcuts in using a compiler index                                     | Low      | Fixed        |
| A11 | Notes drop out of view when their code is renamed or moved                  | Medium   | Fixed        |
| A12 | Command-line searches can use out-of-date vectors                           | Low      | Fixed        |
| A13 | Vendored and generated code is indexed unless `.gitignore` excludes it      | Low      | Fixed        |
| A14 | Language-specific gaps                                                      | Low      | Fixed        |
| R1  | Run on one machine only                                                     | Medium   | Fixed        |
| R2  | Scale is measured only up to about 1,300 files                              | Medium   | Improved     |
| R3  | A compiler index found in the project is trusted without asking             | Medium   | Fixed        |
| R4  | Repository text reaches the assistant and the terminal unfiltered           | Medium   | Fixed        |
| R5  | One unexplained test failure                                                | Low      | Fixed        |
| R6  | Notes, vectors and settings have no format version                          | Medium   | Fixed        |
| R7  | Ollama sometimes takes seconds to answer                                    | Low      | Fixed        |
| H1  | The 3D view has no automated tests                                          | Medium   | Fixed        |
| H2  | No linter, formatter, CI or line-ending rules                               | Medium   | Fixed        |
| H3  | The packages are not ready to publish                                       | Medium   | Partly fixed |
| H4  | Rough edges on the command line                                             | Low      | Fixed        |
| H5  | The page's script is one 1.7 MB file                                        | Low      | Fixed        |
| H6  | Dependencies are unaudited, and the parsers come from VS Code's own package | Low      | Partly fixed |
| N1  | No licence                                                                  | High     | Fixed        |
| N2  | Never used by a real MCP client                                             | High     | Fixed        |
| N3  | npm packages not published                                                  | Medium   | Your call    |
| N4  | Languages that are not parsed                                               | Medium   | Fixed        |
| N5  | Go, Rust, Java and C# tried only on small fixtures                          | Medium   | Improved     |
| N6  | The optional extras are only partly tried                                   | Low      | Partly fixed |

## Still open

### Waiting for your decision

- **N3 and the rest of H3. npm publication.** The repository now has a home on GitHub. Before
  npm publication, fill in package metadata, include each package's copy of `LICENSE`, and
  check whether `vertskim` is free on npm.
- **N6, what is left.** `scip-python` 0.6.8 does not run on Windows (see below); it would need
  Linux, WSL or the CI. The `transformers` provider and embedding models other than
  `nomic-embed-text` have not been tried.

### Not done, no decision needed

- **A8 and A9. Finding the right starting point.** Over the 34 questions the right answer is in
  search's first five 20 times from names alone and 22 times with search by meaning. The real
  client showed the same thing: `graph_search` with a sentence often found only partial matches,
  and the assistant then fell back to Grep.
- **A1, what is left.** One name-only guess in this repository is one the compiler has no view
  on; none is contradicted. In the eight outside projects, guesses were right in most samples but
  not all (see N5): untyped values in Ruby and lambda parameters typed by a library remain hard.
- **R2, what is left.**
  - Parsing runs on the server's main thread, so during a first index tool calls wait up to
    15 s and then answer from what is indexed so far.
  - The walk stops at 100,000 files (the status line says so).
  - Search by meaning keeps all vectors in memory, up to 80,000 (about 240 MB at 768 dimensions).
  - The 3D view builds each picture from a copy of the whole graph in memory.
  - Nothing larger than `node_modules` here (6,447 files) has been indexed.
- **H6, what is left.** Most grammars come from `@vscode/tree-sitter-wasm`, a package made
  for VS Code's own use, and some lag behind their languages: MediatR uses a C# 12 collection
  expression (`return [];`) that the bundled C# grammar cannot parse. Kotlin, Swift and others
  would need grammars from somewhere else. Luau/Lua now use a separately vendored MIT-licensed
  grammar; see [`packages/core/grammars/README.md`](packages/core/grammars/README.md).

### Limits of the new work

These are also in the README's list of limits.

- **Go interfaces** (A14) are matched by method names and the number of parameters and results,
  not their types, so the `implements` edges are guesses. An interface satisfied by more than 50
  types gets none.
- **C and C++** (N4): include paths come from where files are, not from the build; macros are not
  expanded (when a file does not parse, the common annotation and export macros are blanked out
  and it is parsed again, which halves the files with errors but does not remove them all); a
  declaration with several definitions keeps its uses at the declaration; C is parsed with the
  C++ grammar; namespaces are not nodes.
- **Ruby** (N4): methods made by metaprogramming (`attr_reader`, `define_method`) are not nodes;
  only `x = Foo.new` gives a variable a type; a module reopened in several files is a node in
  each.
- **PHP** (N4): `require` and `include` are not followed; `@var` types in doc comments are not
  read.
- **Luau and Lua:** table-based classes and the usual `__index` inheritance are conventions,
  not type-checker results. Dynamic require arguments, numeric asset IDs, computed exports
  and arbitrary metatable effects are not evaluated. Roblox paths are inferred from files and
  Rojo mappings, without a running data model. Lua shares the Luau parser, with fallbacks for
  labels and bitwise operators; other Lua 5.4 syntax can still fail. The
  [validation notes](docs/luau-validation.md) give the tested syntax and limits.
- **Rust macros** (A14): calls in a macro's arguments are read from its tokens; what a macro
  generates is not seen.

## What the real code, the real client and the browser found

### Eight outside projects (N5)

Each was shallow-cloned outside the repository, indexed read-only, and then judged two ways:
counts of what came out, and random samples of edges read against the source by hand.

| Project          | Language | Files | First index | Files that do not parse | Resolved calls | Guesses |
| ---------------- | -------- | ----- | ----------- | ----------------------- | -------------- | ------- |
| go-chi/chi       | Go       | 90    | 0.6 s       | 0                       | 933            | 15      |
| rust-lang/log    | Rust     | 13    | 0.4 s       | 0                       | 275            | 27      |
| google/gson      | Java     | 266   | 2.8 s       | 0                       | 7,295          | 145     |
| jbogard/MediatR  | C#       | 160   | 1.5 s       | 1                       | 514            | 149     |
| google/leveldb   | C++, C   | 133   | 2.6 s       | 14                      | 2,901          | 131     |
| DaveGamble/cJSON | C        | 53    | 1.4 s       | 11                      | 1,356          | 0       |
| rack/rack        | Ruby     | 95    | 2.1 s       | 0                       | 607            | 75      |
| slimphp/Slim     | PHP      | 125   | 1.1 s       | 0                       | 1,247          | 255     |

- **Resolved calls:** all 24 sampled (C++, Ruby, PHP, Java) were right.
- **Guesses**, in the last sample of each: Go 9 of 10, C++ 8 of 8, PHP 8 of 8, C# 7 of 8,
  Ruby 6 of 8, Java 6 of 8 (before the last two Java fixes below), Rust about 6 of 8.
- **Go's implicit interfaces:** all 12 `implements` edges in chi are right, including types that
  satisfy an interface only through an embedded struct.

What the first pass showed, and what was done about it:

- **C and C++ macros.** Annotations (`GUARDED_BY(mu)`), export wrappers
  (`CJSON_PUBLIC(const char *)`) and calling conventions (`CJSON_CDECL`) stopped a third to half
  of the files from parsing. Such files are now parsed a second time with those macros blanked
  out, every position kept: leveldb's files with errors went from 33 to 14, its resolved calls
  from 1,725 to 2,901 and its base classes from 10 to 64; cJSON's files with errors went from 29
  to 11.
- **Stale symbols.** The rule that keeps a file's last good symbols while it has a syntax error
  (A3) would have kept them for ever in a file that never parses cleanly: a function deleted
  from such a C file would have stayed in the graph. It now applies only when the stored symbols
  came from a clean parse.
- **The line of a syntax error** was reported as line 1 when the parser marks a missing token
  without flagging it; it is now found by following the error down the tree.
- **Fake packages.** Rust's `pub use VisitSource as Visitor;` was taken for a crate named
  `VisitSource`; PHP's `use RuntimeException;` and `use function sprintf;` for Composer packages.
  The first now names something in scope, the second PHP's own global namespace (`ext:php/php`).
- **Overloads** (`Send`, `Send~2`), and a C++ declaration beside its definition, counted as
  several candidates, so no name-only match was ever made for them. They now count as one.
- **Calls on library values.** No guess is made for a call on a capitalised receiver that names no
  type in the project (`Task.Run()`, `String::from()`, `::File.stat`); a cast says what a value is
  (`((WildcardType) t).getUpperBounds()`); a chain that starts with `new X()` is a chain on an X;
  and each language has a list of standard-library method names too common to match by name
  (`getName`, `cmp`, `each`, `bytesize`). Name-only guesses fell from 685 to 145 in gson, from
  218 to 75 in rack and from 73 to 15 in chi.
- **Typed receivers in other grammars.** Chains such as `w.Header().Add()` are now followed back
  to `w` in every grammar, not only JavaScript and Python. In Go, `var x pkg.T` and `x := pkg.New()`
  give `x` a type. In C++, Java and C#, a field used without `this` (`env_->RemoveFile()`) is
  typed through the method's class.
- **Ruby** names written from the top (`::Rack::Utils`) are found, and an imported file no
  longer singles out one of several same-named methods, since Ruby loads everything everywhere.
- **Speed.** Every name looked up through C++ includes walked the include graph again; each
  file's re-exports are now worked out once per run. leveldb's first index went from 12.4 s to
  2.6 s, and `three.js` from 8.9 s to 8.0 s.

### A real MCP client (N2)

Claude Code (`claude -p`, Opus 5.5) was given Vertskim as its only MCP server for this repository,
with read-only file tools and no shell or editing. In one session (34 turns, 113 s, $0.81) it
answered four questions, every answer checked against the code:

- what makes a call a name-only guess (it found the four functions involved);
- what to update if `GraphStore.addEdge` changes (every caller, through `graph_impact` and Grep);
- how a change on disk reaches the 3D view (watcher, sync, graph version, the server's poll, the
  event stream, the page);
- a note on the C++ macro clean-up, left with `graph_annotate` on the right function after it had
  checked the claim in the code.

Of its 33 tool calls, 19 went to Vertskim (`graph_context`, `graph_search`, `graph_node`,
`graph_neighbors`, `graph_impact`, `graph_annotate`) and 14 to Grep or Read, mostly after a
sentence-long `graph_search` found only partial matches (A8). (A mistake in the script that ran
it sent all four questions to the same session; they were meant to be asked one at a time.) It also spotted a real bug: an edge drawn first
as a guess stayed marked as one when a typed call later proved it, so the clean-up of
contradicted guesses could have deleted a proven edge. Fixed, with a test.

### Node 22 (R1)

The packages said Node 22.13 or newer. On 22.13 Vertskim could not start: the SQLite built into
that Node (3.47.2) has no full-text search (FTS5), which the graph's search needs. Node added it
in 22.16.0. The floor is now 22.16 everywhere (`engines`, CI, README), an older Node gets a
one-line explanation instead of a crash, and the whole suite passes on 22.16.

### The 3D view in a browser (H1)

`npm run test:browser` starts the server on a copy of the sample project and drives Chromium
through Playwright: the page draws the graph and reports what it holds, search opens a symbol,
a link opens on the node it names, a note written in the page is kept, light and dark follow the
system, and a change to the project shows without a reload. No error is logged in any of them.
The page's content security policy is strict enough to refuse `eval`, which the test had to work
around. The tests run in CI on Linux; locally they need `npx playwright install chromium`.

### scip-python (N6)

`scip-python` 0.6.8 fails on Windows before indexing anything: it builds
`new RegExp(path.sep, "g")`, and a lone backslash is not a valid pattern. With that one pattern
fixed by a preload, it then failed inside its own handling of Windows paths. It has to be tried
on Linux. Vertskim's reading of its output is covered only by a generated test index.

## Fixed

### Accuracy

- **A1. Name-only guesses.** At `73ff893` the compiler contradicted 57 of 377 name-only guesses
  (15%). Most of those calls are now linked through types instead (A4). No guess is made for a
  call on a value the file shows to be third-party or one of the language's own objects, for a
  call on `this` or `self`, or on a library type, and code outside the tests is never guessed to
  call a helper kept for them (`testing/`, `__mocks__/`, `fixtures/` and the like). Now:
  50 guesses, 49 confirmed, none contradicted, one the compiler has no view on.
- **A2. Methods of inline types.** Method signatures are taken only from class bodies, interface
  bodies and the object type of a type alias; overload signatures are skipped.
- **A3. Syntax errors.** When a file stops parsing and finds fewer symbols, the symbols of the
  last version that parsed cleanly are kept until it parses again. The first error line is
  reported by `vertskim status`, `graph_node`, `graph_sync` and the status line. Files saved as
  UTF-16 or with a byte-order mark are decoded properly.
- **A4. Calls through variables, parameters and fields.** Receivers are typed from parameter and
  field types, constructor parameter properties, `new X()`, functions with a declared return
  type, values copied from another variable, and Python type hints, through chains such as
  `this.store.db.prepare()`. Syntax alone now finds 98% of the calls the compiler knows (1,548 of
  1,580), against 88% before, and all 1,500 calls linked through imports or types are confirmed.
- **A5. Nested functions.** Functions defined inside functions and methods of object literals
  are nodes when at least 3 lines long, and a bare call finds them in the enclosing scopes.
- **A6. Measuring answers.** `vertskim bench --scip <file>` compares syntax with a compiler
  index; `vertskim bench --questions <file>` scores search and context against questions with
  known answers, 34 of them in `bench/questions.json`.
- **A7. Import aliases.** `paths`, `baseUrl` and `extends` in `tsconfig.json` and
  `jsconfig.json`, `#imports` in `package.json`, and the `exports` of workspace packages now
  resolve to source files.
- **A8. Plain-word tasks** (improved). Function words are dropped and words stemmed; with four or
  more words, a partial match needs a third of them (at least two); `graph_context` says when its
  starting points are weak. From names alone: right answer in search's first five for 20 of 34
  (was 18), mean reciprocal rank 0.52 (was 0.50), in context's first ten for 25 (was 22).
- **A9. Search by meaning** (improved). Each node's text now starts with its description and
  includes more of its body; vectors are remade when that recipe changes. With `nomic-embed-text`:
  right answer in the first five for 22 of 34, mean reciprocal rank 0.55 (was 0.52), in context's
  first ten for 27 (was 25).
- **A10. Compiler-index shortcuts.** A guess is removed only when every call behind it was
  contradicted. An index that carries the text it was made from is checked against the file
  exactly; otherwise a file changed after the index was written is used only if every one of its
  definitions still lines up, instead of 80% of them.
- **A11. Notes on renamed or moved code** follow it, and a note whose code has changed since it
  was written is marked as possibly out of date, in tool output and in the 3D view.
- **A12. Out-of-date vectors.** A command-line search first embeds up to 100 changed nodes.
- **A13. Vendored and generated code.** `vendor/`, `Pods/`, `.svelte-kit/`, `.output/`,
  `.vercel/`, `.netlify/`, `.angular/`, `.expo/`, `.docusaurus/`, `.parcel-cache/`,
  `.nyc_output/`, `storybook-static/`, `.yarn/`, `.pnpm-store/`, `.dart_tool/`, `*.min.js`,
  `*.min.css` and `*.map` are skipped by default.
- **A14. Language gaps.**
  - Rust: calls inside macro arguments (`println!("{}", total(&cart))`, `assert_eq!`) are calls.
  - Go: implicit interfaces get `implements` edges, marked as guesses (see the limits above).
  - C#: whether a base is a class or an interface is decided by what it resolves to, not by an
    `I` at the start of its name.
  - Outlines list methods written in other files: another file of the package in Go, another
    module of the crate in Rust, a source file apart from the header in C++.
  - "Most used" in `graph_overview` weighs each direct user by how much it is used in turn, and
    says how much code depends on a symbol directly or indirectly ("used by 37, 179 in all").

### Robustness

- **R1, what was done.** The code is type-checked against `@types/node` 22. The whole suite was
  run on Node 22.13, which showed the missing full-text search (see above), and passes on 22.16,
  now the oldest supported version. The `node:sqlite` experimental-feature warning that Node 22
  prints is silenced, and nothing else is (tested).
  The macOS failures at `3e0971e` came from comparing `/var` paths with canonical
  `/private/var` paths. Absolute node IDs and SCIP index locations now resolve links
  consistently. The 148-test suite passes on all nine OS/Node combinations in the
  [CI run for `40a0695`](https://github.com/MyKa322/Vertskim/actions/runs/43472522658),
  including the linked-project and compiler-index regression tests on the actual macOS runner.
- **R2. Scale** (improved). All of `node_modules` here: 6,447 files and 65,505 nodes, first index
  in 29 s, 294 to 392 MB of memory, a 176 MB database, every query in 42 ms or less. Importing a
  compiler index now holds one file's text at a time. On `three.js`, a first index takes 8.0 s
  against 10.3 s at `73ff893` (median of three, same machine) while finding more (16,085 nodes
  against 14,914).
- **R3. Compiler index trusted.** An `index.scip` in the project is reported but used only after
  `vertskim scip <file>`.
- **R4. Unfiltered text.** Control characters are stripped from names, signatures, doc comments,
  notes and everything printed by the tools and the command line. The server's instructions tell
  the assistant that text quoted from the repository is data, not instructions, and
  `graph_annotate` repeats it for notes.
- **R5. The unexplained failure** was a temporary folder still in use when a test deleted it on
  Windows; clean-up now retries. A second flaky test, which waited for a node to appear rather
  than for the update that writes it to finish, was fixed too.
- **R6. Format versions.** `notes.db` carries a format version, with migrations, and is opened
  read-only when a newer version wrote it. `vectors.db` carries one too; vectors in a newer
  layout are dropped and made again, since they can always be remade. `scip.json` and
  `embeddings.json` carry `version: 1`.
- **R7. Slow Ollama answers.** The model is asked to stay loaded for 30 minutes after a request
  (checked with a real Ollama). The first query of a session waits up to 20 s for the model to
  load, the model is warmed up in the background, and after a timeout searches use names alone
  for a while instead of waiting again.

### Hygiene

- **H1.** Browser tests for the 3D view (see above).
- **H2.** Biome 2.6.7 checks and formats the code (`npm run lint`, `npm run format`);
  `.editorconfig` and `.gitattributes` set line endings; the CI workflow is written (see R1).
- **H3, what was done.** Every package states `engines` (Node 22.16 or newer), keywords and its
  licence; the installed command starts through `dist/bin.js`; the built 3D view is copied into
  the server package, so publishing that package is enough; the `ui` package is private.
- **H4. Command line.** Unknown commands and options are explained, folders and arguments are
  checked before anything is indexed, and a port already in use is reported as such.
- **H5. Page size.** The page's script is split into the 3D engine (1.26 MB, 326 kB compressed),
  React and the rest, served compressed and cached.
- **H6, what was done.** npm's audit, run when the development tools were installed, reported no
  vulnerabilities. Development tools (Biome, `@types/node`, Playwright) are pinned to exact
  versions.

### Not done before

- **N1. Licence.** Apache 2.0, in `LICENSE` and in every `package.json`, with a `NOTICE` file that
  carries the credit and the link to this repository (it was MIT until 13 November 2026).
- **N2. A real client.** See above.
- **N4. Languages.** C and C++ (through the C++ grammar), Ruby and PHP are parsed, each with its
  own rules for imports, scope and types, tested on fixtures and on real projects (see above).
- **N5. Real projects** (improved). See above: eight projects, small to medium. Large projects in
  these languages have not been tried.
