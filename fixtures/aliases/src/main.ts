import { helper } from "@lib/helpers";
import { startApp } from "@app";
import { thing } from "#internal/thing";
import { shared } from "@acme/shared";
import { format } from "@acme/shared/format";
import { button } from "components/button";
import { z } from "zod";

export function main(): string {
  startApp();
  z.string();
  return format(`${helper()} ${thing()} ${shared()} ${button("ok")}`);
}
