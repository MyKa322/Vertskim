import type { KeyValueStore } from "../db/redis.js";
import * as log from "../utils/log.js";
import { rotate, TOKEN_TTL_SECONDS } from "./tokens.js";

export interface Session {
  userId: string;
  token: string;
}

/** Shared behaviour for anything that persists sessions. */
export abstract class BaseStore {
  constructor(protected readonly db: KeyValueStore) {}

  /** Read a session by token. */
  async loadSession(token: string): Promise<Session | null> {
    const raw = await this.db.fetch(token);
    return raw ? (JSON.parse(raw) as Session) : null;
  }
}

/** Stores sessions and rotates their refresh tokens. */
export class SessionStore extends BaseStore {
  /**
   * Rotates the refresh token and extends the session TTL.
   */
  async refresh(token: string): Promise<Session> {
    const session = await this.loadSession(token);
    if (!session) {
      log.warn("refresh for unknown token");
      throw new Error("unknown session");
    }
    const next: Session = { userId: session.userId, token: rotate(token) };
    await this.persist(next);
    return next;
  }

  private async persist(session: Session): Promise<void> {
    await this.db.put(session.token, JSON.stringify(session), TOKEN_TTL_SECONDS);
  }
}

export default SessionStore;
