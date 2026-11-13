import { existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** The page may only load its own files and talk to its own server: nothing leaves the machine. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const NOT_BUILT = `<!doctype html>
<meta charset="utf-8">
<title>Vertskim</title>
<body style="font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem">
<h1>The visualizer has not been built</h1>
<p>Run <code>npm run build</code> in the Vertskim checkout, then reload this page.</p>
</body>`;

/**
 * Folder holding the built visualizer, or null when it has not been built. The build
 * copies it next to this file; in a checkout that has not run the full build, it is
 * taken from the @vertskim/ui package directly.
 */
export function locateAssets(): string | null {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "ui");
  if (existsSync(join(bundled, "index.html"))) return bundled;
  try {
    const require = createRequire(import.meta.url);
    const dir = join(dirname(require.resolve("@vertskim/ui/package.json")), "dist");
    return existsSync(join(dir, "index.html")) ? dir : null;
  } catch {
    return null;
  }
}

/** Text files are sent compressed when the browser accepts it; each is compressed once. */
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".map"]);
const compressed = new Map<string, { mtimeMs: number; body: Buffer }>();

function gzipped(file: string): Buffer {
  const mtimeMs = statSync(file).mtimeMs;
  const cached = compressed.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.body;
  const body = gzipSync(readFileSync(file), { level: 9 });
  compressed.set(file, { mtimeMs, body });
  return body;
}

/** Serve one file of the visualizer. Unknown paths get the page itself, as for any single-page app. */
export function serveStatic(
  res: ServerResponse,
  assetsDir: string | null,
  pathname: string,
  acceptEncoding: string | string[] | undefined = undefined,
): void {
  const common = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  };
  if (assetsDir === null) {
    res.writeHead(503, { ...common, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(NOT_BUILT);
    return;
  }

  let relative: string;
  try {
    relative = normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, "");
  } catch {
    relative = "";
  }
  let file = join(assetsDir, relative);
  // Never step outside the assets folder, whatever the path says.
  const inside = file === assetsDir || file.startsWith(assetsDir + sep);
  const isFile = inside && relative !== "" && existsSync(file) && statSync(file).isFile();
  if (!isFile) {
    if (extname(relative) !== "") {
      res.writeHead(404, { ...common, "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    file = join(assetsDir, "index.html");
  }

  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  // Built assets carry a content hash in their name; the page itself must always be fresh.
  const hashed = /[\\/]assets[\\/]/.test(file);
  const caching = {
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    Vary: "Accept-Encoding",
  };
  const accepts = /\bgzip\b/.test(Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : (acceptEncoding ?? ""));
  if (accepts && COMPRESSIBLE.has(extname(file).toLowerCase())) {
    const body = gzipped(file);
    res.writeHead(200, {
      ...common,
      ...caching,
      "Content-Type": type,
      "Content-Encoding": "gzip",
      "Content-Length": body.length,
    });
    res.end(body);
    return;
  }
  res.writeHead(200, { ...common, ...caching, "Content-Type": type });
  res.end(readFileSync(file));
}
