import type { FileSubkind } from "../types.js";
import { extname, posixBasename } from "../util.js";

/** Language label by extension. Only some of these have an extractor. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".lua": "lua",
  ".luau": "luau",
  ".sh": "shell",
  ".bash": "shell",
  ".ps1": "powershell",
  ".sql": "sql",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
};

const DOC_EXTS = new Set([".md", ".mdx", ".markdown", ".rst", ".txt", ".adoc"]);
// biome-ignore format: a list of words reads better packed
const CONFIG_EXTS = new Set([
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".lock", ".xml", ".properties", ".env",
]);
// biome-ignore format: a list of words reads better packed
const ASSET_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".bmp", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".wav", ".ogg", ".flac", ".mp4", ".webm", ".mov",
  ".pdf", ".glb", ".gltf", ".fbx", ".obj", ".blend", ".psd",
]);
const DATA_EXTS = new Set([".csv", ".tsv", ".parquet", ".sqlite", ".db", ".ndjson", ".jsonl"]);
// biome-ignore format: a list of words reads better packed
const SOURCE_LANGUAGES = new Set([
  "typescript", "tsx", "javascript", "python", "go", "rust", "java", "kotlin", "csharp", "c", "cpp",
  "ruby", "php", "swift", "lua", "luau", "shell", "powershell", "sql", "css", "scss", "html", "vue", "svelte",
]);
// biome-ignore format: a list of words reads better packed
const CONFIG_BASENAMES = new Set([
  "dockerfile", "makefile", ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".prettierrc", ".eslintrc",
  ".luaurc",
]);

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e)\//i;
const TEST_FILE = /(\.(test|spec)\.[a-z0-9]+$)|(^test_[^/]*\.py$)|(_test\.(py|go|rs)$)|(^conftest\.py$)/i;
/** `InvoiceTest.java`, `StockTests.cs`: case matters, or `Contest.java` would count. */
const TEST_CLASS_FILE = /[a-z0-9_](Test|Tests|IT)\.(java|kt|cs)$/;

export function languageOf(path: string): string | null {
  return LANGUAGE_BY_EXT[extname(path)] ?? null;
}

export function classifyFile(path: string): FileSubkind {
  const ext = extname(path);
  const base = posixBasename(path).toLowerCase();
  if (DOC_EXTS.has(ext)) return "doc";
  if (ASSET_EXTS.has(ext)) return "asset";
  if (DATA_EXTS.has(ext)) return "data";
  const language = LANGUAGE_BY_EXT[ext];
  if (language && SOURCE_LANGUAGES.has(language)) {
    return TEST_FILE.test(base) || TEST_CLASS_FILE.test(posixBasename(path)) || TEST_PATH.test(path)
      ? "test"
      : "source";
  }
  if (CONFIG_EXTS.has(ext) || CONFIG_BASENAMES.has(base) || base.startsWith(".env")) return "config";
  return "other";
}
