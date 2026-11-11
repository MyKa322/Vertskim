import { login, routes } from "./api/routes.js";
import { info } from "./utils/log.js";

export function main(): void {
  info(`routes: ${Object.keys(routes).join(", ")}`);
  info(`token: ${login()}`);
}

main();
