import type { Context } from "hono";
import type { App, Env } from "./types";
import { fail, verifyPassword } from "./security";
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
