import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as TreeSitter from "@vscode/tree-sitter-wasm";

const require = createRequire(import.meta.url);

type Runtime = typeof TreeSitter;

let runtimePromise: Promise<Runtime> | null = null;
const languages = new Map<string, Promise<TreeSitter.Language>>();
const parsers = new Map<string, TreeSitter.Parser>();

/** Load the tree-sitter WASM runtime once per process. */
export function getRuntime(): Promise<Runtime> {
  runtimePromise ??= (async () => {
    // The package is a UMD bundle, so it is loaded through require.
    const mod = require("@vscode/tree-sitter-wasm") as Runtime;
    await mod.Parser.init();
    return mod;
  })();
  return runtimePromise;
}

/** Grammars that `@vscode/tree-sitter-wasm` does not ship, kept in this package (see `grammars/README.md`). */
const OWN_GRAMMARS = fileURLToPath(new URL("../../grammars", import.meta.url));

function grammarPath(grammar: string): string {
  const own = join(OWN_GRAMMARS, `tree-sitter-${grammar}.wasm`);
  if (existsSync(own)) return own;
  const wasmDir = dirname(require.resolve("@vscode/tree-sitter-wasm"));
  return join(wasmDir, `tree-sitter-${grammar}.wasm`);
}

export function loadLanguage(grammar: string): Promise<TreeSitter.Language> {
  let pending = languages.get(grammar);
  if (!pending) {
    pending = getRuntime().then((rt) => rt.Language.load(grammarPath(grammar)));
    languages.set(grammar, pending);
  }
  return pending;
}

/** A parser bound to one grammar, reused across files. */
export async function getParser(grammar: string): Promise<TreeSitter.Parser> {
  let parser = parsers.get(grammar);
  if (!parser) {
    const [rt, language] = await Promise.all([getRuntime(), loadLanguage(grammar)]);
    parser = new rt.Parser();
    parser.setLanguage(language);
    parsers.set(grammar, parser);
  }
  return parser;
}
