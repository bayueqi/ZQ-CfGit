import { z } from "zod";
import type { Hono, Context } from "hono";
import type { App, Env, User } from "./types";
import { fail, verifyPassword } from "./security";
import { deleteCookie } from "hono/cookie";
export async function securityLimit(env: Env, id: string) {
  const key = "security:" + id + ":" + Math.floor(Date.now() / 600000);
  const row = await env.DB.prepare(
    "INSERT INTO login_limits(key,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts",
  )
    .bind(key, Date.now() + 600000)
    .first<{ attempts: number }>();
  if ((row?.attempts || 0) > 10)
    fail(429, "Too many verification attempts; retry in ten minutes");
}
export async function passwordProof(c: Context<App>, password: string) {
  const user = c.get("user") || fail(401, "Sign in required");
  await securityLimit(c.env, "password:" + user.id);
  const row = await c.env.DB.prepare(
    "SELECT password,auth_epoch,has_password FROM users WHERE id=? AND disabled=0",
  )
    .bind(user.id)
    .first<{ password: string; auth_epoch: number; has_password: number }>();
  if (!row || !row.has_password)
    fail(403, "Set a local password before changing security settings");
  if (!(await verifyPassword(password, row.password)))
    fail(403, "Current password is incorrect");
  return row;
}
export function registerAccount(app: Hono<App>) {
  const session = (c: Context<App>) => {
    if (c.get("kind") !== "session" || !c.get("user"))
      fail(403, "Browser session required");
    return c.get("user")!;
  };
  const record = (c: Context<App>, action: string) =>
    c.env.DB.prepare("INSERT INTO audit(actor_id,action) VALUES(?,?)")
      .bind(c.get("user")!.id, action)
      .run();
  app.get("/api/account/security", async (c) => {
    session(c);
    return c.json({ enabled: false, pending: false, recovery_codes_remaining: 0 });
  });
  app.get("/api/account/sessions", async (c) => {
    const u = session(c);
    return c.json({
      sessions: (
        await c.env.DB.prepare(
          "SELECT id,created_at,expires_at,(hash=?) AS current FROM credentials WHERE user_id=? AND kind='session' AND expires_at>? ORDER BY created_at DESC LIMIT 100",
        )
          .bind(c.get("credential"), u.id, Date.now())
          .all()
      ).results,
    });
  });
  app.delete("/api/account/sessions/:id", async (c) => {
    const u = session(c);
    const row = await c.env.DB.prepare(
      "DELETE FROM credentials WHERE id=? AND user_id=? AND kind='session' RETURNING hash",
    )
      .bind(c.req.param("id"), u.id)
      .first<{ hash: string }>();
    if (row?.hash === c.get("credential"))
      deleteCookie(c, "zq-cfgit_session", { path: "/" });
    await record(c, "account.session.revoke");
    return c.json({ ok: true });
  });
  app.get("/api/profiles/:username", async (c) => {
    if (c.get("delegation")) fail(403, "Git delegation cannot read profiles");
    const u = await c.env.DB.prepare(
      "SELECT id,username,created_at FROM users WHERE username=? AND disabled=0",
    )
      .bind(c.req.param("username"))
      .first<User & Record<string, unknown>>();
    if (!u) fail(404, "User not found");
    const viewer = c.get("user")?.id || "",
      before = Number(c.req.query("before") || Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before < 1)
      fail(400, "Invalid activity cursor");
    const allowed =
      "(r.visibility='public' OR (r.workspace_id IS NULL AND r.owner_id=?) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=r.id AND m.user_id=?) OR EXISTS(SELECT 1 FROM workspace_members w WHERE w.workspace_id=r.workspace_id AND w.user_id=?))";
    const [repos, activity] = await Promise.all([
      c.env.DB.prepare(
        `SELECT r.id,r.namespace,r.name,r.description,r.visibility FROM repositories r WHERE r.owner_id=? AND r.workspace_id IS NULL AND r.deleted_at IS NULL AND ${allowed} ORDER BY r.created_at DESC LIMIT 50`,
      )
        .bind(u.id, viewer, viewer, viewer)
        .all(),
      c.env.DB.prepare(
        `SELECT a.id,a.action,a.detail,a.created_at,r.namespace,r.name FROM audit a JOIN repositories r ON r.id=a.repo_id WHERE a.actor_id=? AND a.id<? AND r.deleted_at IS NULL AND ${allowed} ORDER BY a.id DESC LIMIT 50`,
      )
        .bind(u.id, before, viewer, viewer, viewer)
        .all<any>(),
    ]);
    return c.json({
      profile: u,
      repositories: repos.results,
      activity: activity.results,
      next: activity.results.length === 50 ? activity.results.at(-1).id : null,
    });
  });
}
