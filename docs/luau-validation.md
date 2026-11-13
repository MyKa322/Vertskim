# Luau support and CI path fixes

Validated on 13 November 2026, on Windows, with local changes based on `3e0971e`.

## Checks

| Check | Result |
| --- | --- |
| `npm test` (includes the complete build and UI type-check) | 148 passed, Node 26.12.0 |
| Test suite with the official Node 22.16.0 Windows binary | 148 passed |
| Test suite with the official Node 24.0.0 Windows binary | 148 passed |
| Test suite with `TEMP` and `TMP` pointing through a directory junction | 148 passed |
| `npm run lint` | Passed |
| Built UI in headless Chromium, Playwright | 8 passed |
| Packed `@vertskim/core`, extracted outside the repository | Luau extraction passed; grammar, licence and provenance included |
| Vendored grammar compared with a fresh upstream download | SHA-256 matched |

The browser checks include the Luau display name, file icon, long comments, long strings,
keywords and interpolated strings, as well as the existing graph, search, navigation,
notes, themes and live-update checks.

The original [CI run](https://github.com/MyKa322/Vertskim/actions/runs/43398151687) had six
successful Linux/Windows jobs and three failing macOS jobs. The macOS job logs show that
paths reached through `/var` were compared with canonical `/private/var` paths. Absolute
node IDs and SCIP index locations now resolve links consistently. The regression tests
exercise a project and compiler index reached through a link, duplicate index spellings,
forgetting an index by either spelling, and an index outside the project.

These are local results. The updated code has not yet run on the actual Linux/macOS CI
runners; the Windows junction run reproduces the path condition, not those operating systems.

## Real project

[Sleitnick/RbxUtil at `31f9120fca021e3dec275b42bc7047d626962082`](https://github.com/Sleitnick/RbxUtil/tree/31f9120fca021e3dec275b42bc7047d626962082)
was shallow-cloned outside this repository and indexed without running its code.

| Measurement | Result |
| --- | --- |
| Files indexed | 157, including 69 Luau files |
| Full rebuild, including resolution | 0.70 s, Node 26.12.0 on Windows; warm filesystem cache |
| Nodes / edges, whole project | 1,054 / 2,304 |
| Files with parse errors | 0 |
| Luau call edges resolved from scope, imports or type hints | 406 |
| Luau call edges matched by name alone | 51, all marked `heuristic` |
| Project files before and after | Identical names, contents, sizes and modification times |

The first trial found seven files with parse errors. They use generic type packs, generic
function types and `const` bindings newer than the pinned grammar. Position-preserving
fallbacks now cover these, and the rebuilt project has no reported syntax errors.

Five resolved calls and five guesses were selected deterministically from the sorted Luau
call edges (seed `20261113`) and checked against the source. All ten name the intended
function. This small sample does not establish accuracy for the whole graph.

| Caller and source line | Target | Confidence | Source check |
| --- | --- | --- | --- |
| `modules/log/init.luau`, `LogItem.AtMostEvery`, 239 | `ToSeconds` in the same file | resolved | Direct call to the local helper |
| `modules/silo/init.luau`, `Silo.Dispatch`, 211 | `modules/silo/Util.luau#Util.DeepFreeze` | resolved | Call through the imported Util module |
| `modules/concur/init.test.luau`, 66 | `modules/concur/init.luau#Concur.delay` | resolved | Call through the imported Concur module |
| `modules/comm/Server/ServerComm.luau`, `ServerComm.BindFunction`, 82 | `modules/comm/Server/init.luau#Server.BindFunction` | resolved | Comm is required from the parent module |
| `modules/silo/Util.luau`, `Util.Extend`, 38 | `Util.DeepCopy` in the same file | resolved | Direct call on the local module table |
| `modules/silo/init.test.luau`, 210 | `modules/silo/init.luau#Silo.ResetToDefaultState` | heuristic | Receiver is built by Silo.combine |
| `modules/shake/init.test.luau`, 25 | `ci/Test.luau#TestExpect.ToThrow` | heuristic | Expect/Not chain returns the expectation object |
| `modules/option/init.test.luau`, 122 | `modules/option/init.luau#Option.ExpectNone` | heuristic | Receiver is made by Option.Some |
| `modules/trove/init.test.luau`, 157 | `modules/trove/init.luau#Trove.Clean` | heuristic | Receiver is made by Trove.new |
| `modules/option/init.test.luau`, 11 | `modules/option/init.luau#Option.IsSome` | heuristic | Receiver is made by Option.Some |

To repeat a full index with a separate data directory:

```sh
node packages/cli/dist/bin.js --root /path/to/RbxUtil --data-dir /path/to/empty-data index --rebuild
node packages/cli/dist/bin.js --root /path/to/RbxUtil --data-dir /path/to/empty-data status
```

## Supported cases and limits

The polyglot fixture covers table-based classes, colon and dot methods, static methods,
`__index` inheritance, returned modules and tables, re-exports, typed receivers and fields,
Lua/Luau interoperability, relative requires, `.luaurc` aliases, Roblox services, Wally
package references and Rojo mappings. Separate tests check that newly added `init.luau`
modules are discovered and that edits or deletions of alias/Rojo configuration replace
the previous resolutions.

Syntax tests cover attributes, type packs and defaults, generic function types, leading
union markers, read/write fields, typed loop variables, explicit type arguments, type
functions, const bindings, strings, comments, Lua labels and bitwise operators. Signatures
retain the original text; invalid source still reports a syntax error.

The grammar is the unmodified MIT-licensed v1.2.0 WASM, shipped with the package. Its
[provenance and checksum](../packages/core/grammars/README.md) are recorded separately;
no grammar is fetched at runtime.

This remains syntax-based indexing. It does not evaluate dynamic requires, numeric asset
IDs, computed exports or arbitrary metatable effects, and it does not infer every generic
or structural type. Type functions are indexed as functions with their original signature.
Roblox instance paths are based on the on-disk layout and Rojo mappings; an unmapped path
may use a unique folder suffix, which can differ from the runtime data model. Lua files
share the Luau grammar with syntax fallbacks, rather than a complete Lua 5.4 parser.
