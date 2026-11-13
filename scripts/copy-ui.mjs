// Copies the built 3D view into the server package, so that publishing the server
// is enough for the page to work: it no longer needs @vertskim/ui installed beside it.
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const from = join(root, "packages", "ui", "dist");
const to = join(root, "packages", "server", "dist", "ui");
if (!existsSync(join(from, "index.html"))) {
  console.error("copy-ui: packages/ui/dist has not been built");
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log("copy-ui: the 3D view is in packages/server/dist/ui");
