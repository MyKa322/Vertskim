import type { Extraction } from "../types.js";
import { extractCode } from "./engine.js";
import { csharp } from "./languages/csharp.js";
import { go } from "./languages/go.js";
import { java } from "./languages/java.js";
import { javascript, tsx, typescript } from "./languages/javascript.js";
import { python } from "./languages/python.js";
import { rust } from "./languages/rust.js";
import { extractMarkdown } from "./markdown.js";
import type { LanguageSpec } from "./spec.js";

/** Bump when extraction output changes, so existing databases are re-indexed. */
export const EXTRACTOR_VERSION = 3;

/** Files larger than this get a node but are not parsed. */
export const MAX_PARSE_BYTES = 1_500_000;

const SPECS: Record<string, LanguageSpec> = { javascript, typescript, tsx, python, go, rust, java, csharp };

/** Languages whose files are parsed, for status output and documentation. */
export function parsedLanguages(): string[] {
  return ["markdown", ...Object.keys(SPECS)].sort();
}

/** The tree-sitter language definition for a language label, if one exists. */
export function specFor(language: string | null | undefined): LanguageSpec | undefined {
  return language ? SPECS[language] : undefined;
}

/** True when file contents are read and parsed, rather than only listed. */
export function isParseable(language: string | null | undefined): boolean {
  return language === "markdown" || specFor(language) !== undefined;
}

export const EMPTY_EXTRACTION: Extraction = { nodes: [], refs: [], imports: [] };

export async function extractFile(path: string, language: string | null, source: string): Promise<Extraction> {
  if (language === "markdown") return extractMarkdown(path, source);
  const spec = specFor(language);
  return spec ? extractCode(spec, path, source) : EMPTY_EXTRACTION;
}
