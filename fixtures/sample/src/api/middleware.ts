import { SessionStore } from "../auth/index.js";
import type { Session } from "../auth/session.js";

export type Handler = (session: Session) => Promise<void>;

/** Reject requests that do not carry a live session. */
export function requireAuth(store: SessionStore, handler: Handler) {
  return async (token: string): Promise<void> => {
    const session = await store.refresh(token);
    await handler(session);
  };
}
