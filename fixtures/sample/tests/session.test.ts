import { RedisClient } from "../src/db/redis.js";
import { SessionStore } from "../src/auth/session.js";

async function refreshRotatesToken(): Promise<void> {
  const store = new SessionStore(new RedisClient());
  await store.refresh("abc");
}

void refreshRotatesToken();
