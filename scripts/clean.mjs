// Removes build output from every workspace package.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDir = join(fileURLToPath(new URL("..", import.meta.url)), "packages");
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(packagesDir, entry.name);
  rmSync(join(dir, "dist"), { recursive: true, force: true });
  rmSync(join(dir, "tsconfig.tsbuildinfo"), { force: true });
}
