import { randomUUID } from "node:crypto";

export const TOKEN_TTL_SECONDS = 3600;

/** Issue a fresh opaque token. */
export function issueToken(): string {
  return randomUUID();
}

/** Replace a token with a new one, invalidating the old value. */
export function rotate(token: string): string {
  return `${issueToken()}:${token.length}`;
}
