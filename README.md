# Vertskim

A local MCP server that maps a project as a knowledge graph, so an AI assistant can ask
"where is this defined?", "who calls this?" and "what breaks if I change it?" instead of reading
whole files.

Everything runs on your machine. The project directory is only ever read; the graph lives in
your user data folder.

**Status: all five milestones are built.** Indexing for eight languages, live updates, ten tools,
notes that carry over between sessions, the 3D visualizer and a token benchmark work. Two extras
are off until you switch them on: [compiler-accurate relationships](#optional-compiler-accurate-relationships)
from SCIP indexes and [search by meaning](#optional-search-by-meaning) with a local embedding
model. Both have been run against real tools on this repository; see each section for what came
of it.

## The 3D view

```bash
node packages/cli/dist/index.js --root /path/to/project ui
```

This opens your browser on a 3D picture of the project. Directories start as single nodes and
open as you fly into them (or click twice); click a node for its signature, outline,
relationships and source. The page updates as files change and highlights the nodes your
assistant queries. An assistant gets the same link from the `graph_open_ui` tool.

The server listens on `127.0.0.1` only (port 4517, or a free one), and the link carries an access
key, so other programs and other users on the machine cannot read your project through it.
`--no-open` prints the link without opening a browser; `--port` picks the port.

## What works today

- Indexes TypeScript, JavaScript (including TSX/JSX), Python, Go, Rust, Java, C# and Markdown.
  Every other file still gets a node, so links and mentions can point at it.
- Extracts files, directories, classes, interfaces, functions, methods, variables, types and doc
  sections, and connects them with `imports`, `calls`, `references`, `extends`, `implements`,
  `tests`, `mentions` and `links_to` edges.
- Follows imports, namespace imports, re-exports, default exports and base classes, and each
  language's own rules: Go packages and `go.mod`, Rust modules and `impl` blocks, Java packages,
  C# namespaces. Anything matched by name alone is labelled as a guess.
- In Go, Rust, Java and C#, uses the types written on parameters, variables and fields to tell
  which class a `value.method()` call belongs to.
- Watches the project and updates the graph as files change, re-linking only what a change can
  affect.
- Serves ten MCP tools over stdio, with compact text output trimmed to a token budget.
- Keeps notes your assistant (or you) leave on files and symbols, and shows them again whenever
  that code comes up in a later session.
- Shows the graph in a 3D view in your browser, updated live as files change.
- Measures on your own project how many tokens the tools save.
- Optionally reads SCIP indexes, the output of compiler-backed indexers, and replaces its own
  guesses with what the compiler says.
- Optionally finds code by what it does, using an embedding model that runs on your machine.

## Try it

Requires Node.js 22.13 or newer.

```bash
npm install
npm run build
```

Then point the CLI at any project:

```bash
node packages/cli/dist/index.js --root /path/to/project overview
node packages/cli/dist/index.js --root /path/to/project search "session refresh"
node packages/cli/dist/index.js --root /path/to/project node src/auth/session.ts
node packages/cli/dist/index.js --root /path/to/project impact "src/auth/tokens.ts#rotate"
node packages/cli/dist/index.js --root /path/to/project context "refresh tokens are not rotated" --detail source
node packages/cli/dist/index.js --root /path/to/project note src/auth/tokens.ts "Rotation must stay idempotent"
node packages/cli/dist/index.js --root /path/to/project bench
node packages/cli/dist/index.js --root /path/to/project watch
node packages/cli/dist/index.js --root /path/to/project scip          # optional, see below
node packages/cli/dist/index.js --root /path/to/project embed         # optional, see below
```

`--help` lists every command and option.

## Use it from an MCP client

Add a stdio server to the client's MCP configuration:

```json
{
  "mcpServers": {
    "vertskim": {
      "command": "node",
      "args": ["/absolute/path/to/Vertskim/packages/cli/dist/index.js", "mcp", "--root", "/path/to/project"]
    }
  }
}
```

Leave `--root` out when the client starts servers in the project directory. The root is taken
from `--root`, then the `VERTSKIM_ROOT` environment variable, then the current directory.

## Tools

| Tool | Use it for | Returns |
|---|---|---|
| `graph_overview` | Getting oriented in a project or directory | Size, languages, layout, entry points, the most depended-on files and symbols, external dependencies |
| `graph_context` | Starting a task | The most relevant symbols for a task description or seed ids, with source for the core ones on request |
| `graph_search` | Finding a file, symbol or doc section by name, keywords or path fragment, and by description when search by meaning is on | Ranked matches with id, kind, signature and location |
| `graph_node` | Inspecting specific nodes | Signature, doc comment, an outline of members, direct relationships, and the node's own source lines on request |
| `graph_neighbors` | "Who uses this?" and "what does this depend on?" | Callers, callees, importers, subclasses, tests and docs, up to three hops |
| `graph_impact` | Checking a change before making it | Everything that depends on the targets, nearest first, plus tests to run and docs that mention them |
| `graph_path` | "How does A reach B?" | The shortest chain of relationships, in either direction |
| `graph_annotate` | Keeping what was learned | Saves a note on a node, lists notes, or removes one. Notes appear with their node in the tools above |
| `graph_sync` | Results that look out of date | Re-checks the project (or given paths) and reports what changed; can rebuild the index |
| `graph_open_ui` | Showing the project as a picture | The link to the 3D view, optionally flying to one node |

All tools are read-only except `graph_sync`, which changes the index, `graph_annotate`, which
writes notes to the data folder, and `graph_open_ui`, which starts the local server. None of them
changes the project.
Query tools take `max_tokens` and end their reply with a line saying how current the index is.
Edges prefixed with `~` were matched by name only. Search results prefixed with `≈` were found by
meaning rather than by name.

### Node ids

Ids are readable and stable, and are what you pass between tools:

| Node | Example |
|---|---|
| File | `src/auth/session.ts` |
| Directory | `src/auth/` (the project root is `./`) |
| Symbol | `src/auth/session.ts#SessionStore.refresh` |
| Doc section | `docs/guide.md#install` (the heading's GitHub anchor) |
| Third-party module | `ext:npm/react`, `ext:py/requests` |

## Notes

An assistant starts every session knowing nothing about the last one. `graph_annotate` lets it
leave what it worked out (a decision and its reason, a trap, unfinished work) on the file, symbol
or directory it is about:

```
graph_annotate { "id": "src/auth/tokens.ts#rotate", "note": "Must stay idempotent: retries call it twice." }
```

From then on the note is part of what `graph_node`, `graph_context`, `graph_search` and
`graph_overview` say about that node, and `graph_search` also matches the words of notes.

- Notes are stored in `notes.db` in the data folder, separately from the index, so re-indexing
  and upgrades keep them. Nothing is written into the project.
- Each note remembers what its code looked like. When that function, class or file changes
  afterwards, the note is still shown but marked as written before the change. Notes whose node
  has been renamed or deleted are listed by `graph_annotate` with no arguments.
- You can read, add and remove notes yourself: `vertskim note`, `vertskim notes`, or the Notes
  box in the 3D view.

## How much it saves

`vertskim bench` compares, on your project, the size of what the tools return with the size of
what an assistant would otherwise read to answer the same question. On this repository at the
time of writing (128 files, 863 symbols), median tokens per question:

| Question | Without the graph | With it | Difference |
|---|---|---|---|
| Get oriented in the project | 5,097 | 712 | 86% less |
| See what a file contains | 1,459 | 316 | 78% less |
| Read one function or class | 1,874 | 136 | 93% less |
| Find who uses a symbol | 160 | 70 | 56% less |
| Gather the code around a symbol | 4,708 | 746 | 84% less |
| Check what a change would affect | 2,296 | 181 | 92% less |

How to read this:

- "Without the graph" is a stated assumption per question, printed with the results: reading the
  whole file to see one function, a whole-word text search to find users, the same search with ten
  lines of context to judge a change. An assistant that already knows where to look reads less.
- The saving grows with the size of the project. On the 18-file sample under `fixtures/sample`
  the same run shows 35% less for reading a function, about the same for gathering context, and
  88% *more* for the overview: there is little to save in a project that fits on a screen.
- The graph's answer was the longer one in a few cases (6 of 40 outlines, 6 of 40 "who uses"
  questions here); the output says how many.
- Tokens are estimated at 3.6 characters each, the same way on both sides.
- Only size is measured, not whether the answer is right or complete. A text search finds uses
  the graph cannot see, such as names in strings; the graph tells a call from a comment.

## Optional: compiler-accurate relationships

Vertskim works relationships out from syntax. For `store.refresh()` it cannot know the type of
`store`, so it either guesses from the name (marked `~`) or draws nothing. A compiler knows.
[SCIP](https://github.com/sourcegraph/scip) is a file format in which compiler-backed indexers
write down exactly which name refers to which definition, and Vertskim can read it.

Indexers exist for TypeScript and JavaScript (`scip-typescript`), Python (`scip-python`), Java,
Scala and Kotlin (`scip-java`), Rust (`rust-analyzer`), C and C++ (`scip-clang`), Ruby
(`scip-ruby`), C# (`scip-dotnet`), Dart and PHP. Vertskim does not run them; you do, for example:

```bash
npx @sourcegraph/scip-typescript index
```

That writes `index.scip` where it is run (add `--infer-tsconfig` for a JavaScript project, and
`--output <file>` to put the index somewhere else).

- An `index.scip` at the project root is found by itself. Point at one kept anywhere else, such
  as a package of a monorepo or a file from your CI, with `vertskim scip <file>`. `vertskim scip`
  lists the indexes in use and how many files each covers; `vertskim scip --forget <file>` stops
  using one.
- In the files an index covers, a guess the compiler confirms becomes a plain edge, and
  relationships syntax cannot see are added: calls through fields, interfaces and inferred
  types, uses of a type's fields, and which method implements or overrides which.
- A guess is removed only when the compiler contradicts it: it resolved that name, used that way
  in that function, to something else (a library method, say). Where the compiler has no opinion,
  as with a value typed `any`, the guess stays and stays marked `~`.
- In a monorepo, packages usually see each other through built declaration files, so a call into
  another package refers to `dist/store.d.ts`, not `src/store.ts`. Vertskim follows such a
  reference back to the source when exactly one file of that package fits.
- An index is a snapshot. Its facts about a relationship are used only while both files involved
  are byte-for-byte what they were when it was read. Edit a file and its edges fall back to
  syntax until you run the indexer again; the index file is re-read whenever it changes.
- Nothing is taken on trust: before a fact is used, the name has to be at the position in the
  file where the index says it is. A file that no longer matches its index is left out, and
  `vertskim scip` says how many were.
- The index file is the indexer's output, not Vertskim's. Vertskim never writes it and does not
  index it. Keep it out of version control, or outside the project, as you prefer.

What it did on this repository, with `scip-typescript` 0.6.2 over the five packages (78 files,
read in under a second): of the 377 guesses in those files, 320 were confirmed and 57 removed.
Every one removed was wrong, most of them SQLite's `.all()` taken for a method of that name in
the notes store. None was left. It also added 571 relationships syntax had missed, 146 of them
calls, mostly from one package into another.

## Optional: search by meaning

Search matches names, signatures and doc comments. A question phrased in words the code never
uses ("renew expired credentials" for a method called `refresh`) finds nothing that way. With an
embedding model, `graph_search` and `graph_context` also find code by what it does.

Vertskim does not contain or download a model. It uses one that runs on your machine:

```bash
ollama pull nomic-embed-text      # once, if you use Ollama
vertskim embed                    # finds the model, makes the vectors
```

- **Ollama:** `vertskim embed` finds an embedding model by itself, or name one with
  `--model <name>`. `OLLAMA_HOST` is honoured.
- **LM Studio, llama.cpp and anything else that serves `/v1/embeddings`:**
  `vertskim embed --provider openai --url http://127.0.0.1:1234/v1 --model <name>`.
- **In-process:** `vertskim embed --provider transformers --model <name>` runs the model inside
  Vertskim with [transformers.js](https://huggingface.co/docs/transformers.js), if you have
  installed `@huggingface/transformers` next to it. That library fetches the model from Hugging
  Face the first time it is used.

What happens then:

- Every function, method, class, interface, type, doc section and parsed file gets one vector,
  made from its name, location, signature, doc comment and first lines. Vectors are stored in
  `vectors.db` in the data folder and survive the index being rebuilt.
- A vector is remade only when that text changes. The MCP server, `vertskim ui` and
  `vertskim watch` do this in the background after each update; `vertskim embed` does it now and
  shows progress.
- A one-word query that matches a name is answered from names alone, without asking the model.
  For anything else, matches by name and by meaning are merged; what both agree on comes first,
  and what only the model found is marked `≈`.
- `graph_context` uses the same vectors to pick starting points for a task.
- If the model server is not running, search carries on by name alone and `graph_sync` says so.
- Only a model server on this machine is accepted. `--allow-remote` lifts that, in which case the
  text described above is sent to that server; `--key-env NAME` reads its key from an environment
  variable, and the key is never stored.
- `vertskim embed --off` switches it off and deletes the vectors.

What it did on this repository, with `nomic-embed-text` served by Ollama 0.40.13: 998 vectors in
about 40 seconds the first time, model loading included, and 12 seconds on a re-run. A question
usually costs 15 to 20 ms; now and then Ollama took three seconds over one. The same model file
served by llama.cpp's `llama-server` worked through the `openai` provider. For 16 questions
written so as to share no words with the code they are about ("read a variable-length integer
from binary data"), the model put the right function or file in its first five for 10, and first
or second for 6. It missed badly on 4, ranking the right function below sixty others. It widens
what search can find; it does not replace knowing a name.

## How it stays current

- The server watches the project with the operating system's own change notifications and
  updates the graph about a tenth of a second after a burst of saves ends.
- Before answering, a tool checks the files of the nodes it was asked about directly on disk, so
  an edit made a moment earlier is seen even if the notification has not arrived.
- A full re-scan runs when the server starts, when ignore rules change, and every ten minutes of
  use as a check against missed notifications.
- Where no watcher is available, the project is re-scanned before queries instead, at most every
  1.5 seconds.
- Several clients can run a server on the same project. A lock file in the data folder lets one
  process at a time rewrite the graph; the others then find little or nothing left to do.

## Where your data goes

- The database is stored in `%LOCALAPPDATA%\vertskim\` on Windows,
  `~/Library/Application Support/vertskim/` on macOS, and `~/.local/share/vertskim/` on Linux.
  Set `VERTSKIM_DATA_DIR` or pass `--data-dir` to move it. `vertskim status` prints the exact folder.
- It holds names, signatures, doc comments and line numbers. Source text is read from disk when
  asked for and is not copied into the database.
- Notes are kept beside it in `notes.db`. The index can be deleted and rebuilt at any time; the
  notes file is the only thing in the folder that cannot be recreated.
- With the optional extras in use, the folder also holds `scip.json` (index files you pointed
  at), `embeddings.json` (the model you chose) and `vectors.db`.
- Nothing is sent over the network, with one exception you have to switch on: search by meaning
  sends text to the embedding model server you chose, which has to be on this machine unless you
  explicitly allow another.

## What gets indexed

`.gitignore` files are honoured at every level, along with an optional `.vertskimignore` in the
same format. Common build and dependency folders (`node_modules/`, `dist/`, `build/`, `.venv/` and
similar) are skipped by default; re-include one with a negated pattern such as `!dist/` in
`.vertskimignore`. Symlinks are not followed.

## Limits

- Without a SCIP index, edges come from syntax, not from a type checker. A call on a value whose
  type is unknown (`store.refresh()`) is linked only when exactly one method has that name, and
  is marked `~`. When several candidates exist the edge is left out, so `graph_impact` can miss
  such callers.
- Declared types are used only in Go, Rust, Java and C#, and only where the type is written
  next to the name. A Go `c := cart.New()` or a C# `var x = Make()` leaves the type unknown, so
  calls on it fall back to the name-only rule above. TypeScript and Python calls on values always do.
- Other language-specific gaps: code inside Rust macro calls (`println!`, `assert_eq!`) is seen
  as references, not calls. Go interfaces are satisfied implicitly, so no `implements` edge is
  drawn for them. In C#, a base type counts as an interface when its name starts with `I` and a
  capital. A method written in a different file from its type (Go, Rust) is found by calls but
  is not listed in the type's outline.
- C, C++, Ruby, PHP, Kotlin and Swift files get a node but are not parsed.
- Indexing is single-threaded: roughly 100 files per second on first run. Later updates only
  process changed files.
- "Most used" in `graph_overview` counts direct dependents. There is no PageRank-style ranking
  yet.
- Without search by meaning, `graph_context` finds starting points by matching words against
  names, signatures and doc comments, so a task phrased in words the code never uses needs
  `seeds`.
- A SCIP index only adds relationships between things Vertskim has nodes for. In languages it
  does not parse, and for local variables, parameters and fields, an index adds nothing (a use of
  a field counts as a use of its type). An index has to be re-made by you after edits; nothing
  runs indexers automatically.
- Search by meaning is as good as the model you give it, and always returns its closest matches
  even when nothing in the project is really about the question. Vectors are searched in memory:
  at most 80,000 nodes are embedded, about 3 MB of memory per thousand at 768 dimensions. The
  search box of the 3D view matches by name only.
- A guess is also removed when the compiler resolved the same name, used the same way, somewhere
  else in the same function, even if the guess came from a call the compiler was silent about.
- Only `scip-typescript` has been run for real. Indexes from the other indexers are read by the
  same code and the format is the same, but what each one emits differs in details that only
  show up on real output, as they did here. The automated tests use generated index files and a
  stand-in model server; the `transformers` provider has not been run at all.
- The 3D view has a dark theme only, and the server builds each picture from a copy of the whole
  graph held in memory, which has not been tried on very large repositories.
- Not published to npm yet; run it from a checkout as shown above.

## Repository layout

```
packages/core    indexing engine, graph store, watcher and analysis (no MCP, no HTTP)
packages/mcp     MCP tools, output formatting, token budgets, the benchmark
packages/server  local HTTP server behind the 3D view: API, live events, access checks
packages/ui      the 3D view itself (React + 3d-force-graph), built into static files
packages/cli     the `vertskim` command
fixtures/        sample projects used by the tests: TypeScript + Python + Markdown, and one each
                 for Go, Rust, Java and C#
```

Adding a language means adding one file under `packages/core/src/extract/languages/`: a
tree-sitter query using the shared capture names, plus a few small hooks for what the query cannot
say (what counts as exported, how an import maps to files, which files share a package). See
`packages/core/src/extract/spec.ts`; `go.ts` is the shortest complete example.

```bash
npm test
```

## Roadmap

1. **Done:** indexer for TypeScript/JavaScript, Python and Markdown; SQLite store;
   `graph_search`, `graph_node`, `graph_neighbors` over stdio.
2. **Done:** file watcher and targeted updates; `graph_overview`, `graph_context`,
   `graph_impact`, `graph_path`, `graph_sync`.
3. **Done:** local HTTP server with live events, the 3D visualizer, `graph_open_ui`.
4. **Done:** Go, Rust, Java and C#; notes written back by the assistant (`graph_annotate`);
   the token benchmark (`vertskim bench`).
5. **Done:** compiler-accurate edges from SCIP indexes (`vertskim scip`), tried with
   `scip-typescript`, and optional search by meaning (`vertskim embed`), tried with Ollama and
   llama.cpp. The original plan was to
   bundle transformers.js and the `sqlite-vec` extension. Instead the model runs in a server you
   already have, or in transformers.js if you install it, and vectors are compared in plain
   JavaScript: nothing heavy is installed for people who do not use the feature, and nothing is
   downloaded behind your back.

Still open: C, C++, Ruby and PHP; declared types for TypeScript; trying indexers other than
`scip-typescript`, and the `transformers` provider; publishing to npm.
