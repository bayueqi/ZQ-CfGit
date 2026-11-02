import { Hono, Context } from "hono";
import type { App, Repo } from "./types";
import { branch, sha, fail, boundedBody } from "./security";
import { z } from "zod";
interface Helpers {
  access: (
    c: Context<App>,
    level?: "read" | "write" | "maintain",
  ) => Promise<Repo>;
  engine: (
    c: Context<App>,
    repo: Repo,
    path: string,
    options?: any,
  ) => Promise<Response>;
}
export function registerForgeRoutes(app: Hono<App>, h: Helpers) {
  for (const [route, path] of Object.entries({
    browse: "/browse",
    "tree-updates": "/tree-updates",
    file: "/file",
    commit: "/commit-detail",
    diff: "/diff",
    tags: "/tags",
  })) {
    const read = async (c: Context<App>) => {
      const repo = await h.access(c),
        headers = new Headers();
      for (const name of [
        "range",
        "if-match",
        "if-none-match",
        "if-modified-since",
        "if-unmodified-since",
        "if-range",
      ]) {
        const value = c.req.header(name);
        if (value) headers.set(name, value);
      }
      return h.engine(c, repo, path + new URL(c.req.url).search, {
        headers,
        method: c.req.method,
      });
    };
    app.get("/api/repos/:namespace/:repo/" + route, read);
    if (route === "file")
      app.on("HEAD", "/api/repos/:namespace/:repo/file", read);
  }
  const post = async (
    c: Context<App>,
    path: string,
    level: "read" | "write",
    schema?: z.ZodType<any>,
    operation?: string,
  ) => {
    const repo = await h.access(c, level);
    let data;
    try {
      data = JSON.parse(
        new TextDecoder().decode(
          await boundedBody(c.req.raw, 12 * 1024 * 1024),
        ),
      );
    } catch {
      fail(400, "Invalid JSON");
    }
    if (schema) data = schema.parse(data);
    const user = c.get("user");
    if (user && !data.author)
      data.author = {
        name: user.username,
        email: user.username + "@users.zq-cfgit.local",
      };
    const response = await h.engine(c, repo, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(operation ? { ...data, operation } : data),
      mutation: level === "write",
    });
    return response;
  };
  app.post("/api/repos/:namespace/:repo/branches/create", (c) =>
    post(
      c,
      "/branches/create",
      "write",
      z.object({
        target_branch: branch,
        base_ref: z.string().optional(),
        base_branch: z.string().optional(),
        base_is_ephemeral: z.boolean().optional(),
        ephemeral: z.boolean().optional(),
        expected_target_sha: sha.nullable().optional(),
      }),
    ),
  );
  app.delete("/api/repos/:namespace/:repo/branches", (c) =>
    post(
      c,
      "/branches/delete",
      "write",
      z.object({
        branch: branch,
        ephemeral: z.boolean().optional(),
        expected_sha: sha.optional(),
      }),
    ),
  );
  app.post("/api/repos/:namespace/:repo/tags", (c) =>
    post(
      c,
      "/tags/create",
      "write",
      z.object({
        name: z.string().min(1).max(200),
        ref: z.string().optional(),
        sha: sha.optional(),
        ephemeral: z.boolean().optional(),
      }),
    ),
  );
  app.delete("/api/repos/:namespace/:repo/tags/:tag", async (c) => {
    const repo = await h.access(c, "write");
    const response = await h.engine(c, repo, "/tags/delete", {
      method: "POST",
      body: JSON.stringify({
        name: c.req.param("tag"),
        ephemeral: c.req.query("ephemeral") === "true",
      }),
    });
    return response;
  });
  app.post("/api/repos/:namespace/:repo/archive", (c) =>
    post(c, "/archive", "read"),
  );
}
