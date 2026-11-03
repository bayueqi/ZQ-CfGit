import { canonicalPageURL } from "./domain";
import packageInfo from "../package.json" with { type: "json" };
import { confirmGitResponse } from "./git/confirmation";
import { repositoryAt } from "./project-transfer";
import { projectDatabase } from "./project-db";
import { archivedApiWrite, archiveError } from "./project-state";
import { passwordProof } from "./account";
import { repositoryRole } from "./access";
import { base64, unbase64 } from "./git/signatures";
import { registerForgeRoutes } from "./forge-routes";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z, ZodError } from "zod";
import type { App, Repo, User } from "./types";
import {
  slug,
  repoName,
  branch,
  sha,
  fail,
  digest,
  randomToken,
  passwordHash,
  verifyPassword,
  equal,
  boundedBody,
} from "./security";
const app = new Hono<App>();
const PERMANENT_EXPIRY = Date.UTC(9999, 11, 31);
const userInput = z.object({
  username: slug,
  password: z.string().min(12).max(128),
});
async function input<T>(
  c: Context<App>,
  schema: z.ZodType<T>,
  limit = 2 * 1024 * 1024,
): Promise<T> {
  const b = await boundedBody(c.req.raw, limit);
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(b));
  } catch {
    fail(400, "Invalid JSON");
  }
  return schema.parse(data);
}
const requireUser = (c: Context<App>) =>
  c.get("user") || fail(401, "Sign in required");
async function repoAccess(
  c: Context<App>,
  level: "read" | "write" | "maintain" = "read",
): Promise<Repo> {
  const namespace = c.req.param("namespace"),
    name = c.req.param("repo");
  const located = await repositoryAt(c.env, namespace || "", name || "");
  if (!located) fail(404, "Repository not found");
  const { repo: r, moved } = located;
  const user = c.get("user");
  const role = repositoryRole(r, user);
  c.set("repoRole", role);
  if (moved) {
    if (role !== "owner") fail(404, "Repository not found");
    if (!["GET", "HEAD"].includes(c.req.method))
      fail(409, "Project moved; fetch the current project URL before writing");
    const url = new URL(c.req.url);
    url.pathname =
      "/api/repos/" +
      r.namespace +
      "/" +
      encodeURIComponent(r.name) +
      url.pathname
        .split("/")
        .slice(5)
        .map((s) => "/" + s)
        .join("");
    throw new HTTPException(307, {
      res: new Response(null, {
        status: 307,
        headers: { Location: url.href, "Cache-Control": "no-store" },
      }),
    });
  }
  if (
    r.archived_at &&
    archivedApiWrite(c.req.method, c.req.path.split("/").slice(5).join("/"))
  )
    fail(409, "Repository archived; an owner must unarchive it before writing");
  if (role !== "owner") {
    if (!user) fail(401, "Authentication required");
    fail(404, "Repository not found");
  }
  if (level !== "read" && c.get("scope") === "read")
    fail(403, "Read-only token");
  c.env = {
    ...c.env,
    DB: projectDatabase(c.env.DB, r.id, r.lifecycle_revision || 0),
  };
  return r;
}
async function engine(
  c: Context<App>,
  repo: Repo,
  path: string,
  options: {
    method?: string;
    body?: BodyInit | null;
    headers?: HeadersInit;
    mutation?: boolean;
    namespace?: "ephemeral";
  } = {},
) {
  const headers = new Headers(options.headers);
  headers.delete("x-namespace");
  headers.set("x-repo-id", repo.id);
  headers.set("x-lifecycle-revision", String(repo.lifecycle_revision || 0));
  headers.set("x-default-branch", repo.default_branch);
  if (options.namespace) headers.set("x-namespace", options.namespace);
  else if (c.req.query("ephemeral") === "true")
    headers.set("x-namespace", "ephemeral");
  if (options.mutation) headers.set("x-mutation", "1");
  const ns = c.env.REPOSITORIES;
  return ns.get(ns.idFromName(repo.id)).fetch(
    new Request(`http://repository${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body,
    }),
  );
}
async function engineJSON(
  c: Context<App>,
  r: Repo,
  path: string,
  payload?: unknown,
) {
  const response = await engine(
    c,
    r,
    path,
    payload === undefined
      ? {}
      : {
          method: "POST",
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
          mutation: true,
        },
  );
  const data = (await response.json()) as any;
  if (!response.ok)
    throw new HTTPException(response.status as 400, {
      message: data.error || "Git operation failed",
    });
  return data;
}
app.onError((err, c) => {
  if (err instanceof ZodError)
    return c.json(
      {
        error: "Invalid input",
        details: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      400,
    );
  if (err instanceof HTTPException) {
    if (err.res) return err.getResponse();
    // Basic challenges are for native Git/LFS clients. On JSON API requests
    // browsers otherwise pause fetch while waiting for an HTTP auth dialog.
    if (
      err.status === 401 &&
      !/^\/(api|mcp)(\/|$)/.test(c.req.path) &&
      /^\/[^/]+\/[^/]+\.git\//.test(c.req.path)
    )
      c.header("WWW-Authenticate", 'Basic realm="ZQ-CfGit", charset="UTF-8"');
    return c.json({ error: err.message }, err.status);
  }
  if (archiveError(err)) return c.json({ error: "Repository archived" }, 409);
  console.error("Request failed", err instanceof Error ? err.name : "unknown");
  return c.json(
    { error: "Internal error; retry or contact the administrator" },
    500,
  );
});
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header("X-Frame-Options", "DENY");
  if (!c.res.headers.has("Content-Security-Policy"))
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  if (!c.res.headers.has("Cache-Control"))
    c.header("Cache-Control", "no-store");
});
const staticPaths = new Set([
  "/i18n.js",
  "/app.js",
  "/forge.js",
  "/markdown.js",
  "/notebook.js",
  "/highlight.js",
  "/style.css",
  "/logo.png",
  "/favicon.png",
  "/apple-touch-icon.png",
]);
app.get("*", async (c, next) => {
  const canonical = canonicalPageURL(
    c.req.raw,
    c.env.APP_ORIGIN,
    c.env.LEGACY_APP_ORIGIN,
  );
  if (canonical) return c.redirect(canonical, 308);
  const path = c.req.path;
  let decodedPath: string;
  try {
    decodedPath = decodeURI(path);
  } catch {
    return c.text("Invalid URL encoding", 400);
  }
  if (
    /^\/(api|mcp)(\/|$)/.test(path) ||
    path === "/llms.txt" ||
    decodedPath.includes(".git")
  )
    return next();
  const url = new URL(c.req.url),
    asset = staticPaths.has(path);
  if (!asset) {
    url.pathname = "/index.html";
    url.search = "";
  }
  // Shell and build assets contain no private repository/session data.
  const response = await c.env.ASSETS.fetch(
    new Request(url, {
      method: "GET",
      headers: asset
        ? { "If-None-Match": c.req.header("if-none-match") || "" }
        : {},
    }),
  );
  const headers = new Headers(response.headers);
  headers.set(
    "Cache-Control",
    c.env.APP_ORIGIN.startsWith("http://localhost")
      ? "no-store"
      : asset && /^[a-f0-9]{16}$/.test(url.searchParams.get("v") || "")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate",
  );
  if (!asset) {
    headers.delete("ETag");
    headers.set("Content-Language", "zh-CN");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  if (mutating && origin && origin !== c.env.APP_ORIGIN)
    fail(403, "Cross-origin request rejected");
  if (/^\/api\/runner(?:\/|$)/.test(c.req.path)) return next();
  c.set("user", null);
  c.set("scope", "read");
  c.set("kind", null);
  c.set("credential", null);
  const authorization = c.req.header("authorization");
  let token: string | undefined;
  if (authorization?.startsWith("Bearer ")) token = authorization.slice(7);
  else if (authorization?.startsWith("Basic ")) {
    try {
      const basic = atob(authorization.slice(6));
      token = basic.slice(basic.indexOf(":") + 1);
    } catch {
      fail(401, "Invalid credentials");
    }
  } else if (authorization) fail(401, "Unsupported authorization");
  const cookie = !authorization
    ? getCookie(c, "zq-cfgit_session")
    : undefined;
  token ||= cookie;
  if (token) {
    const hash = await digest(token);
    const row = await c.env.DB.prepare(
      "SELECT u.id,u.username,u.admin,c.scope,c.kind FROM credentials c JOIN users u ON u.id=c.user_id WHERE u.disabled=0 AND c.hash=? AND c.expires_at>?",
    )
      .bind(hash, Date.now())
      .first<User & { scope: "read" | "write"; kind: "pat" | "session" }>();
    if (row && (cookie ? row.kind === "session" : row.kind === "pat")) {
      c.set("user", { id: row.id, username: row.username, admin: row.admin });
      c.set("scope", row.scope);
      c.set("kind", row.kind);
      c.set("credential", hash);
    } else if (authorization) fail(401, "Invalid or expired access token");
  }
  if (mutating && c.get("kind") === "session" && origin !== c.env.APP_ORIGIN)
    fail(403, "Session requests require a matching Origin header");
  if (
    mutating &&
    c.req.path.startsWith("/api/") &&
    c.get("user") &&
    c.get("scope") === "read" &&
    !(
      c.req.method === "POST" &&
      /^\/api\/repos\/[^/]+\/[^/]+\/archive$/.test(c.req.path)
    )
  )
    fail(403, "Read-only access token");
  await next();
});
app.get("/api/health", (c) =>
  c.json({ name: "ZQ-CfGit", version: packageInfo.version, status: "ok" }),
);
app.get("/api/bootstrap", async (c) =>
  c.json({
    user: c.get("user"),
    required: c.get("user")
      ? false
      : !(await c.env.DB.prepare(
          "SELECT value FROM settings WHERE key='initialized'",
        ).first()),
  }),
);
app.get("/api/setup", async (c) =>
  c.json({
    required: !(await c.env.DB.prepare(
      "SELECT value FROM settings WHERE key='initialized'",
    ).first()),
  }),
);
app.post("/api/setup", async (c) => {
  const b = await input(
    c,
    userInput.extend({ secret: z.string().min(1).max(256) }),
  );
  if (
    !c.env.BOOTSTRAP_SECRET ||
    !equal(await digest(b.secret), await digest(c.env.BOOTSTRAP_SECRET))
  )
    fail(403, "Invalid setup secret");
  if (
    await c.env.DB.prepare(
      "SELECT value FROM settings WHERE key='initialized'",
    ).first()
  )
    fail(409, "Setup already completed");
  const id = crypto.randomUUID(),
    password = await passwordHash(b.password);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO settings(key,value) VALUES('initialized','1')",
      ),
      c.env.DB.prepare(
        "INSERT INTO users(id,username,password,admin) VALUES(?,?,?,1)",
      ).bind(id, b.username, password),
    ]);
  } catch {
    fail(409, "Setup already completed or username unavailable");
  }
  return c.json({ id, username: b.username }, 201);
});
app.post("/api/login", async (c) => {
  const b = await input(
    c,
    z.object({
      username: z.string().min(1).max(48),
      password: z.string().max(128),
    }),
  );
  const now = Date.now(),
    bucket = Math.floor(now / 600000),
    key = await digest(
      `${c.req.header("cf-connecting-ip") || "local"}:${bucket}`,
    );
  const limit = await c.env.DB.prepare(
    "INSERT INTO login_limits(key,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts",
  )
    .bind(key, now + 600000)
    .first<{ attempts: number }>();
  if ((limit?.attempts || 0) > 20)
    fail(429, "Too many sign-in attempts; retry in ten minutes");
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE username=?")
    .bind(b.username.toLowerCase())
    .first<
      User & {
        password: string;
        disabled: number;
        auth_epoch: number;
        has_password: number;
      }
    >();
  const valid = await verifyPassword(
    b.password,
    user?.password ||
      "pbkdf2:100000:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000",
  );
  if (!user || user.disabled || !user.has_password || !valid)
    fail(401, "Invalid username or password");
  const token = randomToken(),
    hash = await digest(token);
  const issued = await c.env.DB.prepare(
    "INSERT INTO credentials(hash,id,user_id,name,kind,expires_at) SELECT ?,?,?,'Browser session','session',? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND password=? AND auth_epoch=? AND disabled=0)",
  )
    .bind(
      hash,
      crypto.randomUUID(),
      user.id,
      now + 7 * 86400000,
      user.id,
      user.password,
      user.auth_epoch,
    )
    .run();
  if (!issued.meta.changes)
    fail(409, "Account security changed; sign in again");
  setCookie(c, "zq-cfgit_session", token, {
    httpOnly: true,
    secure: c.env.APP_ORIGIN.startsWith("https:"),
    sameSite: "Strict",
    path: "/",
    maxAge: 7 * 86400,
  });
  c.executionCtx.waitUntil(
    c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM login_limits WHERE reset_at<?").bind(now),
      c.env.DB.prepare("DELETE FROM credentials WHERE expires_at<?").bind(now),
    ]),
  );
  return c.json({ id: user.id, username: user.username, admin: user.admin });
});
app.post("/api/logout", async (c) => {
  if (c.get("kind") === "session")
    await c.env.DB.prepare("DELETE FROM credentials WHERE hash=?")
      .bind(c.get("credential"))
      .run();
  deleteCookie(c, "zq-cfgit_session", { path: "/" });
  return c.json({ ok: true });
});
app.post("/api/password", async (c) => {
  const u = requireUser(c);
  if (c.get("kind") !== "session")
    fail(403, "Use a browser session to change your password");
  const b = await input(
    c,
    z.object({
      current_password: z.string().max(128),
      new_password: z.string().min(12).max(128),
    }),
  );
  const stored = await passwordProof(c, b.current_password);
  const newHash = await passwordHash(b.new_password);
  const changed = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET password=?,has_password=1 WHERE id=? AND password=? AND auth_epoch=? AND disabled=0 AND EXISTS(SELECT 1 FROM credentials WHERE hash=? AND user_id=users.id AND kind='session' AND expires_at>?)",
    ).bind(
      newHash,
      u.id,
      stored.password,
      stored.auth_epoch,
      c.get("credential"),
      Date.now(),
    ),
    c.env.DB.prepare(
      "DELETE FROM credentials WHERE user_id=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND password=?)",
    ).bind(u.id, u.id, newHash),
  ]);
  if (!changed[0].meta.changes) fail(409, "Password changed; sign in again");
  deleteCookie(c, "zq-cfgit_session", { path: "/" });
  return c.json({ ok: true });
});
app.get("/api/me", (c) => c.json({ user: c.get("user") }));
app.get("/api/tokens", async (c) => {
  const u = requireUser(c);
  return c.json({
    tokens: (
      await c.env.DB.prepare(
        "SELECT id,name,scope,expires_at,created_at FROM credentials WHERE user_id=? AND kind='pat' ORDER BY created_at DESC",
      )
        .bind(u.id)
        .all()
    ).results,
  });
});
app.post("/api/tokens", async (c) => {
  const u = requireUser(c);
  if (c.get("kind") !== "session")
    fail(403, "Use a browser session to create access tokens");
  const b = await input(
    c,
    z.object({
      name: z.string().trim().min(1).max(80),
      scope: z.enum(["read", "write"]).default("write"),
      days: z.number().int().min(0).max(365).default(90),
    }),
  );
  const snapshot = await c.env.DB.prepare(
    "SELECT auth_epoch FROM users WHERE id=? AND disabled=0",
  )
    .bind(u.id)
    .first<{ auth_epoch: number }>();
  if (!snapshot) fail(401, "Sign in required");
  const token = randomToken(),
    id = crypto.randomUUID();
  const minted = await c.env.DB.prepare(
    "INSERT INTO credentials(hash,id,user_id,name,kind,scope,expires_at) SELECT ?,?,?,?,'pat',?,? WHERE EXISTS(SELECT 1 FROM users u JOIN credentials c ON c.user_id=u.id WHERE u.id=? AND u.auth_epoch=? AND u.disabled=0 AND c.hash=? AND c.kind='session' AND c.expires_at>?)",
  )
    .bind(
      await digest(token),
      id,
      u.id,
      b.name,
      b.scope,
      b.days ? Date.now() + b.days * 86400000 : PERMANENT_EXPIRY,
      u.id,
      snapshot.auth_epoch,
      c.get("credential"),
      Date.now(),
    )
    .run();
  if (!minted.meta.changes) fail(409, "Account changed; sign in again");
  return c.json({ id, token }, 201);
});
app.delete("/api/tokens/:id", async (c) => {
  const u = requireUser(c);
  await c.env.DB.prepare(
    "DELETE FROM credentials WHERE id=? AND user_id=? AND kind='pat'",
  )
    .bind(c.req.param("id"), u.id)
    .run();
  return c.json({ ok: true });
});
app.get("/api/repos", async (c) => {
  const u = c.get("user");
  const namespaceFilter = c.req.query("namespace") || "";
  const search = (c.req.query("q") || "").slice(0, 100),
    limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(c.req.query("limit") || 50);
  let offset =
    z.coerce
      .number()
      .int()
      .min(0)
      .max(10000)
      .parse(c.req.query("page") || 0) * limit;
  if (c.req.query("cursor")) {
    try {
      const cursor = JSON.parse(
        new TextDecoder().decode(unbase64(c.req.query("cursor")!)),
      );
      if (
        cursor.q !== search ||
        (cursor.namespace || "") !== namespaceFilter ||
        cursor.user !== (u?.id || "") ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset > 1000000
      )
        throw Error();
      offset = cursor.offset;
    } catch {
      fail(400, "Invalid repository cursor");
    }
  }
  const query = `SELECT r.* FROM repositories r WHERE r.deleted_at IS NULL AND r.owner_id=? AND (?='' OR r.namespace=?) AND (r.name LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\') ORDER BY r.created_at DESC,r.id LIMIT ? OFFSET ?`;
  const pattern = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
  const result = await c.env.DB.prepare(query)
    .bind(
      u?.id || "",
      namespaceFilter,
      namespaceFilter,
      pattern,
      pattern,
      limit + 1,
      offset,
    )
    .all();
  const has_more = result.results.length > limit;
  return c.json({
    repositories: result.results.slice(0, limit),
    page: Math.floor(offset / limit),
    has_more,
    next_cursor: has_more
      ? base64(
          new TextEncoder().encode(
            JSON.stringify({
              q: search,
              namespace: namespaceFilter,
              user: u?.id || "",
              offset: offset + limit,
            }),
          ),
        )
      : null,
  });
});
app.post("/api/repos", async (c) => {
  const u = requireUser(c);
  const b = await input(
    c,
    z.object({
      namespace: slug.optional(),
      name: repoName.optional(),
      id: repoName.optional(),
      description: z.string().max(1000).default(""),
      default_branch: branch.optional(),
    }),
  );
  const namespace = b.namespace || u.username;
  const id = crypto.randomUUID();
  b.name = b.name || b.id || id;
  b.default_branch = b.default_branch || "main";
  try {
    await c.env.DB.prepare(
      "INSERT INTO repositories(id,owner_id,namespace,name,description,visibility,default_branch) VALUES(?,?,?,?,?,'private',?)",
    )
      .bind(
        id,
        u.id,
        namespace,
        b.name,
        b.description,
        b.default_branch,
      )
      .run();
  } catch {
    fail(409, "Repository name already exists");
  }
  return c.json(
    {
      id,
      namespace,
      ...b,
      clone_url: `${c.env.APP_ORIGIN}/${namespace}/${encodeURIComponent(b.name)}.git`,
    },
    201,
  );
});
app.get("/api/repos/:namespace/:repo", async (c) => {
  const r = await repoAccess(c);
  return c.json({
    ...r,
    role: c.get("repoRole"),
    clone_url: `${c.env.APP_ORIGIN}/${r.namespace}/${encodeURIComponent(r.name)}.git`,
  });
});
app.post("/api/repos/:namespace/:repo/transfer", async (c) => {
  const r = await repoAccess(c, "maintain");
  if (c.get("repoRole") !== "owner")
    fail(403, "Project owner required");
  const b = await input(
    c,
    z.object({
      name: repoName,
      revision: z.number().int().min(0),
    }),
  );
  return c.json(
    await engineJSON(c, r, "/internal/transfer", {
      name: b.name,
      revision: b.revision,
      actor_id: requireUser(c).id,
    }),
  );
});
app.post("/api/repos/:namespace/:repo/sync", async (c) => {
  const r = await repoAccess(c, "maintain");
  if (c.get("repoRole") !== "owner")
    fail(403, "Project owner required");
  const b = await input(
    c,
    z.object({ source: z.string().trim().min(1).max(500) }),
  );
  const u = requireUser(c);
  // 归档下载、解包与对象落库都在 Durable Object 内完成，主 Worker 只做一次转发，
  // 避免大仓库把脚本执行时间耗在解包和转码上。
  const snap: any = await engineJSON(c, r, "/sync-github", {
    source: b.source,
    target_branch: r.default_branch,
    author: {
      name: u.username,
      email: u.username + "@users.zq-cfgit.local",
    },
  });
  await c.env.DB.prepare("UPDATE repositories SET base_repo=? WHERE id=?")
    .bind(snap.source, r.id)
    .run();
  return c.json(snap);
});
app.put("/api/repos/:namespace/:repo/lifecycle", async (c) => {
  const r = await repoAccess(c, "maintain");
  if (c.get("repoRole") !== "owner")
    fail(403, "Project owner required");
  const b = await input(
    c,
    z.object({ archived: z.boolean(), revision: z.number().int().min(0) }),
  );
  return c.json(
    await engineJSON(c, r, "/internal/lifecycle", {
      ...b,
      actor_id: requireUser(c).id,
    }),
  );
});
app.patch("/api/repos/:namespace/:repo", async (c) => {
  const r = await repoAccess(c, "maintain");
  const b = await input(
    c,
    z.object({
      description: z.string().max(1000).optional(),
      default_branch: branch.optional(),
    }),
  );
  if (b.default_branch)
    await engineJSON(c, r, "/internal/default-branch", {
      default_branch: b.default_branch,
    });
  await c.env.DB.prepare(
    "UPDATE repositories SET description=? WHERE id=?",
  )
    .bind(b.description ?? r.description, r.id)
    .run();
  return c.json({ ok: true });
});
app.delete("/api/repos/:namespace/:repo", async (c) => {
  const r = await repoAccess(c, "maintain");
  return engine(c, r, "/internal/delete", { method: "POST" });
});
app.get("/api/repo-url/:id", async (c) => {
  const r = await c.env.DB.prepare(
    "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL",
  )
    .bind(c.req.param("id"))
    .first<Repo>();
  if (!r) fail(404, "Repository not found");
  if (repositoryRole(r, c.get("user")) !== "owner")
    fail(404, "Repository not found");
  return c.json({
    id: r.id,
    namespace: r.namespace,
    name: r.name,
    url: `${c.env.APP_ORIGIN}/${r.namespace}/${encodeURIComponent(r.name)}.git`,
    ephemeral_url: `${c.env.APP_ORIGIN}/${r.namespace}/${encodeURIComponent(r.name)}+ephemeral.git`,
  });
});
app.get("/api/repos/:namespace/:repo/preview", async (c) => {
  const r = await repoAccess(c),
    response = await engine(c, r, "/file" + new URL(c.req.url).search);
  if (!response.ok) return response;
  const bytes = await boundedBody(response, 24 * 1024 * 1024),
    is = (start: number, values: number[]) =>
      values.every((x, i) => bytes[start + i] === x),
    head = new TextDecoder()
      .decode(bytes.subarray(0, 512))
      .replace(/^\uFEFF/, "")
      .trimStart()
      .toLowerCase(),
    mime = is(0, [137, 80, 78, 71, 13, 10, 26, 10])
      ? "image/png"
      : is(0, [255, 216, 255])
        ? "image/jpeg"
        : is(0, [71, 73, 70, 56]) &&
            (bytes[4] === 55 || bytes[4] === 57) &&
            bytes[5] === 97
          ? "image/gif"
          : is(0, [82, 73, 70, 70]) && is(8, [87, 69, 66, 80])
            ? "image/webp"
            : head.startsWith("<svg") ||
                /^<\?xml[^>]*>\s*(<!--[\s\S]*?-->\s*)*<svg/.test(head)
              ? "image/svg+xml"
              : null;
  if (!mime) fail(400, "Preview supports PNG, JPEG, GIF, WebP and SVG images");
  const headers: Record<string, string> = {
    "content-type": mime,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  // 只有 SVG 能被当页面直接打开，加 sandbox 让其中的脚本在本站没有执行环境。
  if (mime === "image/svg+xml") {
    headers["content-security-policy"] = "sandbox";
    headers["content-disposition"] = "inline";
  }
  return new Response(bytes as BodyInit, { headers });
});
registerForgeRoutes(app, { access: repoAccess, engine });
for (const operation of [
  "branches",
  "tree",
  "blob",
  "blame",
  "commits",
  "search",
])
  app.get(`/api/repos/:namespace/:repo/${operation}`, async (c) => {
    const r = await repoAccess(c);
    return engine(c, r, `/${operation}${new URL(c.req.url).search}`);
  });
app.post("/api/repos/:namespace/:repo/commit", async (c) => {
  const r = await repoAccess(c, "write"),
    u = requireUser(c);
  const b = await input(
    c,
    z.object({
      branch: branch,
      expected_sha: sha.nullable(),
      message: z.string().min(1).max(1000),
      files: z
        .array(
          z.object({
            path: z.string().min(1).max(1000),
            content: z
              .string()
              .max(8 * 1024 * 1024)
              .nullable(),
          }),
        )
        .min(1)
        .max(30),
    }),
    24 * 1024 * 1024,
  );
  const result = await engineJSON(c, r, "/commit", {
    ...b,
    author: u.username,
    email: `${u.username}@users.zq-cfgit.local`,
  });
  return c.json(result, 201);
});
app.all("/:namespace/:git/*", async (c, next) => {
  const gitName = c.req.param("git");
  if (!gitName.endsWith(".git")) return next();
  let name = gitName.slice(0, -4);
  const gitNamespace = name.endsWith("+ephemeral") ? "ephemeral" : undefined;
  if (gitNamespace) name = name.slice(0, -gitNamespace.length - 1);
  repoName.parse(name);
  slug.parse(c.req.param("namespace"));
  // Hono route params are immutable: authorize through the same repository policy using an explicit lookup.
  const located = await repositoryAt(c.env, c.req.param("namespace"), name);
  if (!located) fail(404, "Repository not found");
  const { repo: r, moved } = located;
  const suffix = new URL(c.req.url).pathname.split("/").slice(3).join("/"),
    u = c.get("user");
  let writing =
    suffix === "git-receive-pack" ||
    c.req.query("service") === "git-receive-pack" ||
    c.req.method === "PUT";
  let batch: any;
  if (suffix === "info/lfs/objects/batch" && c.req.method === "POST") {
    batch = await input(
      c,
      z.object({
        operation: z.enum(["upload", "download"]),
        transfers: z.array(z.string()).optional(),
        objects: z
          .array(
            z.object({
              oid: z.string().regex(/^[0-9a-f]{64}$/),
              size: z
                .number()
                .int()
                .min(0)
                .max(16 * 1024 * 1024),
            }),
          )
          .max(100),
      }),
    );
    writing = batch.operation === "upload";
  }
  const role = repositoryRole(r, u),
    read = role === "owner",
    write = role === "owner";
  if (!read)
    fail(u ? 404 : 401, "Repository not found or authentication required");
  if (writing && (!write || c.get("scope") !== "write"))
    fail(u ? 403 : 401, "Write access required");
  // Git may POST to its original base even after following discovery redirects.
  // Authorization above used the current destination and every forwarded request carries its revision.
  if (moved && c.req.method === "GET") {
    const url = new URL(c.req.url);
    url.pathname =
      "/" +
      r.namespace +
      "/" +
      encodeURIComponent(r.name) +
      (gitNamespace ? "+" + gitNamespace : "") +
      ".git/" +
      suffix;
    return c.redirect(url.href, 307);
  }
  if (writing && r.archived_at) fail(409, "Repository archived");
  if (batch) {
    const objects = [];
    for (const object of batch.objects) {
      const exists = await c.env.OBJECTS.head(`lfs/${r.id}/${object.oid}`);
      const auth = c.req.header("authorization");
      const header = auth ? { Authorization: auth } : {};
      const href = `${c.env.APP_ORIGIN}/${r.namespace}/${encodeURIComponent(r.name)}.git/info/lfs/objects/${object.oid}`;
      if (exists && exists.size !== object.size) {
        objects.push({
          ...object,
          error: { code: 422, message: "Size does not match stored object" },
        });
        continue;
      }
      objects.push({
        ...object,
        authenticated: !!u,
        ...(batch.operation === "download" && !exists
          ? { error: { code: 404, message: "Object not found" } }
          : { actions: { [batch.operation]: { href, header } } }),
      });
    }
    return c.json({ transfer: "basic", objects });
  }
  const lfs = suffix.match(/^info\/lfs\/objects\/([0-9a-f]{64})$/);
  if (lfs) {
    if (c.req.method === "GET")
      return engine(
        c,
        r,
        "/internal/lfs/" + lfs[1] + new URL(c.req.url).search,
        { namespace: gitNamespace },
      );
    if (c.req.method === "PUT") {
      return engine(c, r, "/internal/lfs/" + lfs[1], {
        method: "PUT",
        body: c.req.raw.body,
        namespace: gitNamespace,
      });
    }
    fail(404, "Unsupported LFS endpoint");
  }
  if (!(
    (c.req.method === "GET" &&
      suffix === "info/refs" &&
      ["git-upload-pack", "git-receive-pack"].includes(
        c.req.query("service") || "",
      )) ||
    (c.req.method === "POST" &&
      ["git-upload-pack", "git-receive-pack"].includes(suffix))
  ))
    fail(404, "Unsupported Git endpoint");
  if (c.req.header("content-encoding"))
    fail(400, "Encoded Git requests are not supported");
  const headers = new Headers();
  for (const h of ["content-type", "git-protocol"]) {
    const v = c.req.header(h);
    if (v) headers.set(h, v);
  }
  const forward = () =>
    engine(c, r, `/git/${suffix}${new URL(c.req.url).search}`, {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
      mutation: c.req.method === "POST" && suffix === "git-receive-pack",
      namespace: gitNamespace,
    });
  const response =
    c.req.method === "POST" && suffix === "git-receive-pack"
      ? await confirmGitResponse(r.id, forward)
      : await forward();
  return response;
});
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
app.get("*", async (c) => {
  const url = new URL(c.req.url);
  if (
    url.pathname === "/app.js" ||
    url.pathname === "/forge.js" ||
    url.pathname === "/style.css" ||
    url.pathname === "/favicon.png" ||
    url.pathname === "/logo.png" ||
    url.pathname === "/apple-touch-icon.png"
  )
    return c.env.ASSETS.fetch(c.req.raw);
  url.pathname = "/index.html";
  return c.env.ASSETS.fetch(new Request(url));
});
export default app;
