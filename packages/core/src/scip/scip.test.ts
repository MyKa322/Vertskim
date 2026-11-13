import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Project } from "../project.js";
import { copyFixture, edge, linkTo, removeTempDirs, tempDir, write } from "../testing/helpers.js";
import { encodeScip, FakeIndexBuilder, ROLE_DEFINITION, ROLE_IMPORT } from "../testing/scip.js";
import { readScip, symbolName, type ScipDocument } from "./reader.js";

after(removeTempDirs);

const PKG = "scip-typescript npm sample 1.0.0 ";
const SESSION = `${PKG}src/auth/\`session.ts\`/`;
const REDIS = `${PKG}src/db/\`redis.ts\`/`;
const TOKENS = `${PKG}src/auth/\`tokens.ts\`/`;
const MIDDLEWARE = `${PKG}src/api/\`middleware.ts\`/`;
const ROUTES = `${PKG}src/api/\`routes.ts\`/`;
const JOBS = `${PKG}src/\`jobs.ts\`/`;

const S = {
  Session: `${SESSION}Session#`,
  userId: `${SESSION}Session#userId.`,
  BaseStore: `${SESSION}BaseStore#`,
  baseConstructor: `${SESSION}BaseStore#\`<constructor>\`().`,
  loadSession: `${SESSION}BaseStore#loadSession().`,
  SessionStore: `${SESSION}SessionStore#`,
  refresh: `${SESSION}SessionStore#refresh().`,
  persist: `${SESSION}SessionStore#persist().`,
  KeyValueStore: `${REDIS}KeyValueStore#`,
  fetch: `${REDIS}KeyValueStore#fetch().`,
  put: `${REDIS}KeyValueStore#put().`,
  RedisClient: `${REDIS}RedisClient#`,
  redisFetch: `${REDIS}RedisClient#fetch().`,
  redisPut: `${REDIS}RedisClient#put().`,
  ttl: `${TOKENS}TOKEN_TTL_SECONDS.`,
  issueToken: `${TOKENS}issueToken().`,
  rotate: `${TOKENS}rotate().`,
  requireAuth: `${MIDDLEWARE}requireAuth().`,
  Handler: `${MIDDLEWARE}Handler#`,
  store: `${ROUTES}store.`,
  profile: `${ROUTES}profile.`,
  routes: `${ROUTES}routes.`,
  login: `${ROUTES}login().`,
  warn: `${PKG}src/utils/\`log.ts\`/warn().`,
  Mailer: `${JOBS}Mailer#`,
  unregister: `${JOBS}Mailer#unregister().`,
  defaults: `${JOBS}defaults.`,
  nightly: `${JOBS}nightly().`,
  weekly: `${JOBS}weekly().`,
  hourly: `${JOBS}hourly().`,
  monthly: `${JOBS}monthly().`,
  /** A method of the standard library: defined in no document of the index. */
  libraryUnregister:
    "scip-typescript npm typescript 5.9.3 lib/`lib.es2021.weakref.d.ts`/FinalizationRegistry#unregister().",
};

const ID = {
  Session: "src/auth/session.ts#Session",
  BaseStore: "src/auth/session.ts#BaseStore",
  loadSession: "src/auth/session.ts#BaseStore.loadSession",
  SessionStore: "src/auth/session.ts#SessionStore",
  refresh: "src/auth/session.ts#SessionStore.refresh",
  persist: "src/auth/session.ts#SessionStore.persist",
  KeyValueStore: "src/db/redis.ts#KeyValueStore",
  fetch: "src/db/redis.ts#KeyValueStore.fetch",
  put: "src/db/redis.ts#KeyValueStore.put",
  RedisClient: "src/db/redis.ts#RedisClient",
  redisFetch: "src/db/redis.ts#RedisClient.fetch",
  rotate: "src/auth/tokens.ts#rotate",
  issueToken: "src/auth/tokens.ts#issueToken",
  requireAuth: "src/api/middleware.ts#requireAuth",
  routes: "src/api/routes.ts#routes",
  profile: "src/api/routes.ts#profile",
  store: "src/api/routes.ts#store",
  nightly: "src/jobs.ts#nightly",
  weekly: "src/jobs.ts#weekly",
  hourly: "src/jobs.ts#hourly",
  monthly: "src/jobs.ts#monthly",
  defaults: "src/jobs.ts#defaults",
  unregister: "src/jobs.ts#Mailer.unregister",
};

/**
 * Calls on receivers whose type is not written down, which syntax alone takes for
 * `Mailer.unregister`, the only method of that name. A compiler knows the one in
 * `nightly` is a library method and the one in `hourly` really is Mailer's, and has
 * nothing to say about the two on `any`.
 */
const JOBS_SOURCE = `export class Mailer {
  unregister(): void {}
}

const defaults = { retries: 3, delay: 10, jitter: 2, limit: 5 };

export function nightly(registry): number {
  registry.unregister(defaults);
  return defaults.retries;
}

export function hourly(mailer): void {
  mailer.unregister();
}

export function both(registry, queue: any): void {
  registry.unregister(queue);
  queue.unregister();
}

export function weekly(queue: any): void {
  queue.unregister();
}

export function monthly(queue: any): void {
  const unregister = 1;
  queue.unregister(unregister);
}
`;

/** What a TypeScript indexer would say about the sample project as it is on disk right now. */
function sampleIndex(root: string, options: { tool?: string; projectRoot?: string | null } = {}): FakeIndexBuilder {
  const index = new FakeIndexBuilder(root, options);
  index
    .doc("src/auth/session.ts")
    .ref('import { rotate, TOKEN_TTL_SECONDS } from "./tokens.js";', "rotate", S.rotate)
    .def("export interface Session {", "Session", S.Session)
    .def("  userId: string;", "userId", S.userId)
    .def("export abstract class BaseStore {", "BaseStore", S.BaseStore)
    .def("constructor(protected readonly db", "constructor", S.baseConstructor)
    .def("async loadSession(token", "loadSession", S.loadSession)
    .ref("await this.db.fetch(token)", "fetch", S.fetch, "single")
    .def("export class SessionStore extends BaseStore {", "SessionStore", S.SessionStore)
    .ref("export class SessionStore extends BaseStore {", "BaseStore", S.BaseStore)
    .def("async refresh(token: string)", "refresh", S.refresh, "single")
    .ref("await this.loadSession(token)", "loadSession", S.loadSession)
    .ref('log.warn("refresh for unknown token")', "warn", S.warn)
    .ref("session.userId, token", "userId", S.userId)
    .ref("token: rotate(token)", "rotate", S.rotate, "unpacked")
    .ref("await this.persist(next)", "persist", S.persist, "multi")
    .def("private async persist(session", "persist", S.persist)
    .ref("await this.db.put(session.token", "put", S.put)
    .ref("TOKEN_TTL_SECONDS);", "TOKEN_TTL_SECONDS", S.ttl)
    .implementing(S.SessionStore, S.BaseStore);
  index
    .doc("src/db/redis.ts")
    .def("export interface KeyValueStore {", "KeyValueStore", S.KeyValueStore)
    .def("fetch(key: string): Promise<string | null>;", "fetch", S.fetch)
    .def("put(key: string, value: string, ttlSeconds: number): Promise<void>;", "put", S.put)
    .def("export class RedisClient implements KeyValueStore {", "RedisClient", S.RedisClient)
    .def("async fetch(key: string)", "fetch", S.redisFetch)
    .def("async put(key: string", "put", S.redisPut)
    .implementing(S.RedisClient, S.KeyValueStore)
    .implementing(S.redisFetch, S.fetch)
    .implementing(S.redisPut, S.put);
  index
    .doc("src/auth/tokens.ts")
    .def("export const TOKEN_TTL_SECONDS", "TOKEN_TTL_SECONDS", S.ttl)
    .def("export function issueToken()", "issueToken", S.issueToken)
    .def("export function rotate(token", "rotate", S.rotate)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the fixture's own source text
    .ref("${issueToken()}", "issueToken", S.issueToken);
  index
    .doc("src/api/middleware.ts")
    .ref('import { SessionStore } from "../auth/index.js";', "SessionStore", S.SessionStore, "packed", ROLE_IMPORT)
    .def("export type Handler =", "Handler", S.Handler)
    .ref("(session: Session) =>", "Session", S.Session)
    .def("export function requireAuth(", "requireAuth", S.requireAuth)
    .ref("store: SessionStore, handler", "SessionStore", S.SessionStore)
    .ref("handler: Handler)", "Handler", S.Handler)
    .ref("await store.refresh(token)", "refresh", S.refresh);
  index
    .doc("src/api/routes.ts")
    .def("const store = new", "store", S.store)
    .ref("new SessionStore(new RedisClient())", "SessionStore", S.SessionStore)
    .ref("new SessionStore(new RedisClient())", "RedisClient", S.RedisClient)
    .def("const profile: Handler", "profile", S.profile)
    .ref("const profile: Handler", "Handler", S.Handler)
    .ref("console.log(session.userId)", "userId", S.userId)
    .def("export const routes", "routes", S.routes)
    .ref("requireAuth(store, profile)", "requireAuth", S.requireAuth)
    .def("export function login()", "login", S.login)
    .ref("return issueToken();", "issueToken", S.issueToken);
  const jobs = index
    .doc("src/jobs.ts")
    .def("export class Mailer {", "Mailer", S.Mailer)
    .def("unregister(): void {}", "unregister", S.unregister)
    .def("const defaults = {", "defaults", S.defaults)
    .def("export function nightly(", "nightly", S.nightly)
    .ref("registry.unregister(defaults)", "unregister", S.libraryUnregister)
    .ref("registry.unregister(defaults)", "defaults", S.defaults)
    .ref("return defaults.retries;", "defaults", S.defaults)
    .def("export function both(", "both", `${JOBS}both().`)
    .ref("registry.unregister(queue)", "unregister", S.libraryUnregister)
    .def("export function hourly(", "hourly", S.hourly)
    .ref("mailer.unregister();", "unregister", S.unregister)
    .def("export function weekly(", "weekly", S.weekly)
    .def("export function monthly(", "monthly", S.monthly)
    // A local that happens to share the method's name, defined and then passed as an argument.
    .def("const unregister = 1;", "unregister", "local 7")
    .ref("(unregister);", "unregister", "local 7");
  // Members of an object literal get made-up names from the indexer: the name plus a counter.
  for (const key of ["retries", "delay", "jitter", "limit"]) jobs.def(`${key}: `, key, `${JOBS}${key}0:`);
  jobs.ref("return defaults.retries;", "retries", `${JOBS}retries0:`);
  return index;
}

async function openSample(): Promise<{ root: string; project: Project }> {
  const root = copyFixture();
  writeFileSync(join(root, "src/jobs.ts"), JOBS_SOURCE);
  const project = Project.open({ root, dataDir: tempDir("data") });
  await project.sync();
  return { root, project };
}

describe("reading a SCIP index", () => {
  test("finds the name a symbol ends with", () => {
    assert.equal(symbolName(S.refresh), "refresh");
    assert.equal(symbolName(S.SessionStore), "SessionStore");
    assert.equal(symbolName(S.ttl), "TOKEN_TTL_SECONDS");
    assert.equal(symbolName(S.baseConstructor), "<constructor>");
    assert.equal(symbolName(`${PKG}src/\`a.ts\`/`), "a.ts");
    assert.equal(symbolName("rust-analyzer cargo shop 0.1.0 cart/Cart#add()."), "add");
    assert.equal(symbolName("scip-java maven com.acme billing 1.0 com/acme/Invoice#total(+1)."), "total");
    assert.equal(symbolName("scip-python python pkg 1.0 `pkg.mod`/Thing#run().(self)"), "self");
    assert.equal(symbolName("scip-java maven g a 1 com/acme/Box#[T]"), "T");
    assert.equal(symbolName("x y z 1 `odd ``name```."), "odd `name`");
    assert.equal(symbolName("local 12"), null);
    assert.equal(symbolName(""), null);
  });

  test("decodes every way a range can be written, and skips what it does not need", () => {
    const data = encodeScip({
      tool: "scip-typescript",
      version: "0.4.0",
      projectRoot: "file:///work/sample",
      documents: [
        {
          path: "src/a.ts",
          language: "typescript",
          encoding: 2,
          text: "the embedded source, which is not decoded",
          occurrences: [
            { line: 0, start: 7, end: 12, symbol: "a", roles: ROLE_DEFINITION, form: "packed" },
            { line: 3, start: 0, end: 4, symbol: "b", form: "unpacked" },
            { line: 0, start: 0, end: 9, symbol: "c", form: "single" },
            { line: 400, start: 130, end: 200, symbol: "d", form: "multi" },
          ],
          symbols: [{ symbol: "a", implementations: ["b", "c"] }, { symbol: "unrelated" }],
        },
        { path: "src/b.py", language: "python", occurrences: [] },
      ],
    });
    const documents: ScipDocument[] = [];
    const metadata = readScip(data, (doc) => documents.push(doc));
    assert.deepEqual(metadata, {
      projectRoot: "file:///work/sample",
      toolName: "scip-typescript",
      toolVersion: "0.4.0",
    });
    assert.equal(documents.length, 2);
    const [a, b] = documents as [ScipDocument, ScipDocument];
    assert.equal(a.relativePath, "src/a.ts");
    assert.equal(a.language, "typescript");
    assert.equal(a.positionEncoding, 2);
    assert.deepEqual(a.occurrences, [
      { line: 0, start: 7, end: 12, symbol: "a", roles: ROLE_DEFINITION },
      { line: 3, start: 0, end: 4, symbol: "b", roles: 0 },
      { line: 0, start: 0, end: 9, symbol: "c", roles: 0 },
      { line: 400, start: 130, end: 200, symbol: "d", roles: 0 },
    ]);
    // Only symbols that say something about inheritance are kept.
    assert.deepEqual(a.symbols, [
      {
        symbol: "a",
        relationships: [
          { symbol: "b", isImplementation: true },
          { symbol: "c", isImplementation: true },
        ],
      },
    ]);
    assert.equal(b.relativePath, "src/b.py");
    assert.equal(b.positionEncoding, 0);
  });

  test("rejects data that is not an index", () => {
    assert.throws(() => readScip(new Uint8Array(0), () => {}), /does not look like a SCIP index/);
    assert.throws(() => readScip(new TextEncoder().encode('{ "not": "protobuf" }'), () => {}));
    const truncated = encodeScip({ documents: [{ path: "a.ts", occurrences: [] }] }).subarray(0, 30);
    assert.throws(() => readScip(truncated, () => {}));
  });
});

describe("compiler-accurate edges from a SCIP index", () => {
  test("turns guesses into facts, adds what syntax cannot see and drops wrong guesses", async () => {
    const { root, project } = await openSample();
    try {
      // What the syntax tree alone gives: calls through written types are resolved, the rest are guesses.
      assert.equal(edge(project, ID.requireAuth, "calls", ID.refresh)?.confidence, "resolved");
      assert.equal(edge(project, ID.loadSession, "calls", ID.fetch)?.confidence, "resolved");
      for (const caller of [ID.nightly, ID.hourly, ID.weekly, ID.monthly]) {
        assert.equal(edge(project, caller, "calls", ID.unregister)?.confidence, "heuristic");
      }
      assert.deepEqual(project.compilerIndexes(), []);

      const file = sampleIndex(root).write(1);
      // Found at the project root, but not used until asked for: a repository could ship a misleading one.
      await project.sync({ full: true });
      assert.equal(edge(project, ID.hourly, "calls", ID.unregister)?.confidence, "heuristic");
      assert.deepEqual(
        project.compilerIndexes().map((s) => [s.path, s.inUse]),
        [[file, false]],
      );
      await project.addCompilerIndex(file);

      // A name-only guess the compiler confirms, and a resolved call it agrees with.
      assert.equal(edge(project, ID.hourly, "calls", ID.unregister)?.confidence, "exact");
      assert.equal(edge(project, ID.requireAuth, "calls", ID.refresh)?.confidence, "exact");
      // A name-only guess the compiler contradicts: it resolved that call to a library method.
      assert.equal(edge(project, ID.nightly, "calls", ID.unregister), null);
      // Guesses the compiler has no opinion on (the receiver is `any`) stay guesses...
      assert.equal(edge(project, ID.weekly, "calls", ID.unregister)?.confidence, "heuristic");
      // ...also when a local of the same name is used in the same function,
      assert.equal(edge(project, ID.monthly, "calls", ID.unregister)?.confidence, "heuristic");
      // ...and when another call of that name in the same function is a library's.
      assert.equal(edge(project, "src/jobs.ts#both", "calls", ID.unregister)?.confidence, "heuristic");
      assert.equal(edge(project, ID.nightly, "references", ID.defaults)?.confidence, "exact");
      // Calls through a field typed as an interface.
      assert.equal(edge(project, ID.loadSession, "calls", ID.fetch)?.confidence, "exact");
      assert.equal(edge(project, ID.persist, "calls", ID.put)?.confidence, "exact");
      // Edges that were already resolved are confirmed.
      assert.equal(edge(project, ID.refresh, "calls", ID.rotate)?.confidence, "exact");
      assert.equal(edge(project, ID.routes, "calls", ID.requireAuth)?.confidence, "exact");
      assert.equal(edge(project, ID.store, "calls", ID.SessionStore)?.confidence, "exact");
      // Inheritance, between types and between the members that implement each other.
      assert.equal(edge(project, ID.SessionStore, "extends", ID.BaseStore)?.confidence, "exact");
      assert.equal(edge(project, ID.RedisClient, "implements", ID.KeyValueStore)?.confidence, "exact");
      assert.equal(edge(project, ID.redisFetch, "implements", ID.fetch)?.confidence, "exact");
      // The base class named in the class header is inheritance, not a second relationship.
      assert.equal(edge(project, ID.SessionStore, "references", ID.BaseStore), null);
      // Using a field counts as using the type that declares it.
      assert.equal(edge(project, ID.profile, "references", ID.Session)?.confidence, "exact");
      // Names on an import line are not uses.
      assert.equal(edge(project, "src/auth/session.ts", "references", ID.rotate), null);
      assert.equal(edge(project, "src/api/middleware.ts", "references", ID.SessionStore), null);
      // A symbol the index knows but this project has no node for is passed over; the syntax edge stays.
      assert.equal(edge(project, ID.refresh, "calls", "src/utils/log.ts#warn")?.confidence, "resolved");

      const [status] = project.compilerIndexes();
      assert.equal(status?.path, join(root, "index.scip"));
      assert.equal(status?.present, true);
      assert.equal(status?.tool, "scip-typescript 0.4.0");
      assert.equal(status?.documents, 6);
      assert.equal(status?.matched, 6);
      assert.equal(status?.outOfStep, 0);
      assert.equal(status?.filesInUse, 6);
      assert.ok((status?.facts ?? 0) >= 20);

      // The index file itself is not part of the graph.
      assert.equal(project.node("index.scip"), null);

      // Nothing more to do until something changes.
      const again = await project.sync();
      assert.equal(again.resolvedFiles, 0);
    } finally {
      await project.close();
    }
  });

  test("stops trusting a file's facts the moment the file changes", async () => {
    const { root, project } = await openSample();
    try {
      await project.addCompilerIndex(sampleIndex(root).write(1));
      assert.equal(edge(project, ID.requireAuth, "calls", ID.refresh)?.confidence, "exact");

      const path = "src/api/middleware.ts";
      write(root, path, `// edited after the index was built\n${readFileSync(join(root, path), "utf8")}`, 2);
      await project.sync();

      // Its own relationships are back to what the syntax shows...
      assert.equal(edge(project, ID.requireAuth, "calls", ID.refresh)?.confidence, "resolved");
      // ...facts in other files that point into it are no longer vouched for...
      assert.equal(edge(project, ID.routes, "calls", ID.requireAuth)?.confidence, "resolved");
      // ...and files that did not change keep theirs.
      assert.equal(edge(project, ID.loadSession, "calls", ID.fetch)?.confidence, "exact");
      assert.equal(project.compilerIndexes()[0]?.filesInUse, 5);

      // Running the indexer again brings it all back.
      sampleIndex(root).write(3);
      await project.sync();
      assert.equal(edge(project, ID.requireAuth, "calls", ID.refresh)?.confidence, "exact");
      assert.equal(edge(project, ID.routes, "calls", ID.requireAuth)?.confidence, "exact");
      assert.equal(project.compilerIndexes()[0]?.filesInUse, 6);
    } finally {
      await project.close();
    }
  });

  test("leaves out a file that already differed when the index was read", async () => {
    const { root, project } = await openSample();
    try {
      const index = sampleIndex(root);
      // The index describes session.ts as it was; two lines are then added above everything in it.
      const path = "src/auth/session.ts";
      write(root, path, `// one\n// two\n${readFileSync(join(root, path), "utf8")}`, 1);
      await project.addCompilerIndex(index.write(2));

      const [status] = project.compilerIndexes();
      assert.equal(status?.matched, 6);
      assert.equal(status?.outOfStep, 1);
      assert.equal(status?.filesInUse, 5);
      // Nothing the index says about that file is used, in either direction.
      assert.equal(edge(project, ID.loadSession, "calls", ID.fetch)?.confidence, "resolved");
      assert.equal(edge(project, ID.requireAuth, "calls", ID.refresh)?.confidence, "resolved");
      assert.equal(edge(project, ID.SessionStore, "extends", ID.BaseStore)?.confidence, "resolved");
      // The rest of the index still is.
      assert.equal(edge(project, ID.routes, "calls", ID.requireAuth)?.confidence, "exact");
      assert.equal(edge(project, ID.nightly, "calls", ID.unregister), null);
    } finally {
      await project.close();
    }
  });

  test("goes back to the syntax-only graph when the index is removed", async () => {
    const { root, project } = await openSample();
    try {
      const before = project.store.db.prepare("SELECT src, kind, dst, confidence FROM edges ORDER BY 1, 2, 3").all();
      const file = sampleIndex(root).write(1);
      await project.addCompilerIndex(file);
      assert.notDeepEqual(
        project.store.db.prepare("SELECT src, kind, dst, confidence FROM edges ORDER BY 1, 2, 3").all(),
        before,
      );

      rmSync(file);
      const result = await project.sync();
      assert.ok(result.resolvedFiles >= 6);
      assert.deepEqual(
        project.store.db.prepare("SELECT src, kind, dst, confidence FROM edges ORDER BY 1, 2, 3").all(),
        before,
      );
      assert.deepEqual(
        project.compilerIndexes().map((s) => [s.present, s.filesInUse]),
        [[false, 0]],
      );
    } finally {
      await project.close();
    }
  });

  test("uses an index kept outside the project once it is added, until it is forgotten", async () => {
    const { root, project } = await openSample();
    try {
      const elsewhere = join(tempDir("scip"), "sample.scip");
      sampleIndex(root).write(1, elsewhere);
      await project.sync();
      assert.equal(edge(project, ID.requireAuth, "calls", ID.refresh)?.confidence, "resolved");

      await assert.rejects(() => project.addCompilerIndex(join(root, "no-such.scip")));
      const status = await project.addCompilerIndex(elsewhere);
      assert.equal(status?.filesInUse, 6);
      assert.equal(edge(project, ID.requireAuth, "calls", ID.refresh)?.confidence, "exact");

      // It is remembered across restarts.
      const dataDir = project.dataDir;
      await project.close();
      const reopened = Project.open({ root, dataDir });
      try {
        await reopened.sync();
        assert.equal(reopened.compilerIndexes()[0]?.path, elsewhere);
        assert.equal(edge(reopened, ID.requireAuth, "calls", ID.refresh)?.confidence, "exact");

        assert.equal(await reopened.forgetCompilerIndex(elsewhere), true);
        assert.equal(edge(reopened, ID.requireAuth, "calls", ID.refresh)?.confidence, "resolved");
        assert.deepEqual(reopened.compilerIndexes(), []);
        assert.equal(await reopened.forgetCompilerIndex(elsewhere), false);
      } finally {
        await reopened.close();
      }
    } finally {
      await project.close();
    }
  });

  test("matches an index made and added through a link to the project", async (t) => {
    const { root, project } = await openSample();
    try {
      const link = linkTo(root);
      if (!link) {
        t.skip("links cannot be made here");
        return;
      }
      // The indexer ran in the linked folder, so that is the root it recorded and where it wrote.
      const file = sampleIndex(link).write(1);
      const status = await project.addCompilerIndex(file);
      assert.equal(status?.path, join(root, "index.scip"));
      assert.equal(status?.matched, 6);
      assert.equal(status?.filesInUse, 6);
      assert.equal(edge(project, ID.requireAuth, "calls", ID.refresh)?.confidence, "exact");
      // One file under two spellings is one index: listed once, and not also "found, not in use".
      await project.addCompilerIndex(join(root, "index.scip"));
      assert.deepEqual(
        project.compilerIndexes().map((s) => [s.path, s.inUse]),
        [[join(root, "index.scip"), true]],
      );
      // Either spelling forgets it.
      assert.equal(await project.forgetCompilerIndex(file), true);
      assert.equal(edge(project, ID.requireAuth, "calls", ID.refresh)?.confidence, "resolved");
      assert.equal(await project.forgetCompilerIndex(join(root, "index.scip")), false);

      // An index kept elsewhere, behind a link of its own.
      const outside = linkTo(tempDir("scip"));
      assert.ok(outside);
      const elsewhere = sampleIndex(link).write(2, join(outside, "sample.scip"));
      assert.equal((await project.addCompilerIndex(elsewhere))?.filesInUse, 6);
      assert.equal(await project.forgetCompilerIndex(elsewhere), true);

      // No root recorded in it: its paths are then taken from where the index file is.
      const bare = sampleIndex(link, { projectRoot: null }).write(3);
      assert.equal((await project.addCompilerIndex(bare))?.filesInUse, 6);
    } finally {
      await project.close();
    }
  });

  test("reads an index made in a subdirectory, and one that counts in bytes", async () => {
    const { root, project } = await openSample();
    try {
      // A monorepo package indexed on its own: paths are relative to where the indexer ran,
      // and the recorded root is from another machine.
      write(
        root,
        "packages/geo/place.py",
        'def label(name):\n    return "Zürich · " + shorten(name)\n\n\ndef shorten(name):\n    return name[:3]\n',
        1,
      );
      await project.sync();
      const label = "packages/geo/place.py#label";
      const shorten = "packages/geo/place.py#shorten";
      const before = edge(project, label, "calls", shorten);
      assert.equal(before?.confidence, "resolved");

      const sym = (name: string) => `scip-python python geo 0.1 place/${name}().`;
      const index = new FakeIndexBuilder(join(root, "packages/geo"), {
        tool: "scip-python",
        projectRoot: "file:///home/ci/build/geo",
      });
      index
        .doc("place.py", 1)
        .def("def label(name):", "label", sym("label"))
        .def("def shorten(name):", "shorten", sym("shorten"))
        .ref('"Zürich · " + shorten(name)', "shorten", sym("shorten"));
      index.write(2);
      // Not at the project root, so it has to be pointed at.
      const status = await project.addCompilerIndex(join(root, "packages/geo/index.scip"));
      assert.equal(status?.tool, "scip-python 0.4.0");
      assert.equal(status?.filesInUse, 1);
      assert.equal(edge(project, label, "calls", shorten)?.confidence, "exact");
    } finally {
      await project.close();
    }
  });

  test("follows a package's declaration files back to its sources", async () => {
    const { root, project } = await openSample();
    try {
      // What a package looks like to its users in a monorepo: `dist/x.d.ts`, not `src/x.ts`.
      const built = (dir: string, file: string, name: string) => `${PKG}dist/${dir}/\`${file}\`/${name}`;
      const index = new FakeIndexBuilder(root);
      index
        .doc("src/api/middleware.ts")
        .def("export type Handler =", "Handler", S.Handler)
        .def("export function requireAuth(", "requireAuth", S.requireAuth);
      index
        .doc("src/auth/session.ts")
        .def("export class SessionStore extends BaseStore {", "SessionStore", S.SessionStore)
        .def("async refresh(token: string)", "refresh", S.refresh);
      index
        .doc("src/api/routes.ts")
        .withBackslashes() // as scip-typescript writes paths on Windows
        .def("const store = new", "store", S.store)
        .def("export const routes", "routes", S.routes)
        .def("export function login()", "login", S.login)
        .ref("requireAuth(store, profile)", "requireAuth", built("api", "middleware.d.ts", "requireAuth()."))
        .ref("new SessionStore(new RedisClient())", "SessionStore", built("auth", "session.d.ts", "SessionStore#"))
        // No source in this index defines these: a declaration file with no twin proves nothing.
        .ref("return issueToken();", "issueToken", built("auth", "tokens.d.ts", "issueToken()."))
        .ref("new SessionStore(new RedisClient())", "RedisClient", built("db", "redis.d.ts", "RedisClient#"));
      await project.addCompilerIndex(index.write(1));

      assert.equal(edge(project, ID.routes, "calls", ID.requireAuth)?.confidence, "exact");
      assert.equal(edge(project, ID.store, "calls", ID.SessionStore)?.confidence, "exact");
      assert.equal(edge(project, "src/api/routes.ts#login", "calls", ID.issueToken)?.confidence, "resolved");
      assert.equal(edge(project, ID.store, "calls", ID.RedisClient)?.confidence, "resolved");
    } finally {
      await project.close();
    }
  });

  test("is noticed by a watched project the next time it is asked something", async () => {
    const { root, project } = await openSample();
    try {
      await project.watch();
      // In use from the start, but with nothing in it yet.
      await project.addCompilerIndex(new FakeIndexBuilder(root).write(1));
      assert.equal(edge(project, ID.requireAuth, "calls", ID.refresh)?.confidence, "resolved");
      // The indexer finishes; nobody tells Vertskim.
      sampleIndex(root).write(3);
      await project.refresh([ID.requireAuth]);
      assert.equal(edge(project, ID.requireAuth, "calls", ID.refresh)?.confidence, "exact");
    } finally {
      await project.close();
    }
  });

  test("survives a file that is not an index", async () => {
    const { root, project } = await openSample();
    const messages: string[] = [];
    await project.close();
    const logged = Project.open({ root, dataDir: project.dataDir, log: (m) => messages.push(m) });
    try {
      const before = logged.store.db.prepare("SELECT src, kind, dst, confidence FROM edges ORDER BY 1, 2, 3").all();
      write(root, "index.scip", "this is not protobuf at all, just text\n".repeat(20), 1);
      await logged.addCompilerIndex(join(root, "index.scip"));
      assert.deepEqual(
        logged.store.db.prepare("SELECT src, kind, dst, confidence FROM edges ORDER BY 1, 2, 3").all(),
        before,
      );
      assert.ok(messages.some((m) => m.includes("could not read compiler index")));
      const [status] = logged.compilerIndexes();
      assert.equal(status?.present, true);
      assert.equal(status?.filesInUse, 0);
      // It is not read again until it changes.
      messages.length = 0;
      await logged.sync();
      assert.equal(messages.filter((m) => m.includes("compiler index")).length, 0);
    } finally {
      await logged.close();
    }
  });
});
