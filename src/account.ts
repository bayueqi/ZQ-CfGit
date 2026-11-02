import { z } from "zod";
import type { Hono, Context } from "hono";
import type { App, Env } from "./types";
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
}
