import { warn } from "../utils/log.js";

/** Minimal key-value contract the session store relies on. */
export interface KeyValueStore {
  fetch(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** In-memory stand-in for a Redis client. */
export class RedisClient implements KeyValueStore {
  private data = new Map<string, string>();

  async fetch(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) warn(`non-positive ttl for ${key}`);
    this.data.set(key, value);
  }
}
