import type { Context } from "hono";
import type { App } from "./types";
import { fail, boundedBody } from "./security";

export async function jsonInput(c: Context<App>) {
  try {
    return JSON.parse(
      new TextDecoder().decode(await boundedBody(c.req.raw, 128 * 1024)),
    );
  } catch {
    fail(400, "Invalid JSON");
  }
}

export function identity(c: Context<App>) {
  if (c.get("delegation")) fail(403, "Use a user session or personal token");
  return c.get("user") || fail(401, "Sign in required");
}
