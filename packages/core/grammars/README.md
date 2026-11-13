# Vendored grammars

Grammars in this folder ship with `@vertskim/core`. Loading them needs no network access,
native compiler or install script. Other grammars still come from `@vscode/tree-sitter-wasm`.

## Luau

- File: `tree-sitter-luau.wasm` (94,204 bytes), used for both `.luau` and `.lua` files.
- Upstream: [tree-sitter-grammars/tree-sitter-luau, v1.2.0](https://github.com/tree-sitter-grammars/tree-sitter-luau/releases/tag/v1.2.0).
- Download: [the upstream release asset](https://github.com/tree-sitter-grammars/tree-sitter-luau/releases/download/v1.2.0/tree-sitter-luau.wasm).
- SHA-256: `f1647052518f2bdfae8e8c0b033ffdeca1193d69d11c78ba20f84c8374fd0fe3`.
- Licence: MIT, copyright 2023 Amaan Qureshi; the full upstream notice is in
  [tree-sitter-luau.LICENSE](tree-sitter-luau.LICENSE).

This is the unmodified prebuilt release asset. To replace it, download the chosen tagged
release's WASM and licence, verify the checksum, update this record and `NOTICE`, and run
the language tests with the packaged copy. Do not fetch grammars at runtime.

The grammar predates some Luau syntax. `src/extract/languages/luau.ts` retries a failed
parse after blanking unsupported annotations and type syntax, keeping every source
position unchanged. The retry is used only when it has fewer errors; malformed files
still appear in `status`.
