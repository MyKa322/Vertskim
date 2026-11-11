import SessionStore from "../auth/session.js";
import { issueToken } from "../auth/index.js";
import { RedisClient } from "../db/redis.js";
import { requireAuth, type Handler } from "./middleware.js";

const store = new SessionStore(new RedisClient());

const profile: Handler = async (session) => {
  console.log(session.userId);
};

export const routes = {
  "/profile": requireAuth(store, profile),
};

export function login(): string {
  return issueToken();
}
