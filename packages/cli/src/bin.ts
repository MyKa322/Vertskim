#!/usr/bin/env node
// The installed `vertskim` command. The warning filter has to be in place before
// node:sqlite is first loaded, so the rest of the program is imported only after it.
import { silenceSqliteWarning } from "./warnings.js";

silenceSqliteWarning();
await import("./index.js");
