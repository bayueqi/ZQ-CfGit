import type { Hono, Context } from "hono";
import type { App, Repo } from "./types";
import { z } from "zod";
import { branch, sha, fail, slug } from "./security";
import { jsonInput, identity } from "./http-input";
import { repositoryRole, roleRank } from "./access";
interface Helpers {
  access(c: Context<App>, level?: "read" | "write" | "maintain"): Promise<Repo>;
  engine(
    c: Context<App>,
    r: Repo,
    path: string,
    payload?: unknown,
  ): Promise<any>;
  audit(
    c: Context<App>,
    action: string,
    id: string,
    detail?: string,
  ): Promise<void>;
}
export function registerCollaboration(app: Hono<App>, h: Helpers) {
  const base = "/api/repos/:namespace/:repo";
  const access = async (
    c: Context<App>,
    level: "read" | "write" | "maintain" = "read",
  ) => {
    if (c.get("delegation"))
      fail(403, "Git delegation cannot manage collaboration");
    if (level !== "read") identity(c);
    return h.access(c, level);
  };
  const mrFor = async (
    c: Context<App>,
    level: "read" | "write" | "maintain" = "read",
  ) => {
    const repo = await access(c, level);
    const mr = await c.env.DB.prepare(
      "SELECT m.*,u.username AS author FROM merge_requests m JOIN users u ON u.id=m.author_id WHERE m.repo_id=? AND m.id=?",
    )
      .bind(repo.id, c.req.param("id"))
      .first<any>();
    if (!mr) fail(404, "Merge request not found");
    return { repo, mr };
  };
  const snapshotFor = async (
    c: Context<App>,
    target: Repo,
    sourceBranch: string,
    targetBranch: string,
  ) => {
    const user = identity(c);
    if (roleRank[await repositoryRole(c.env, target, user)] < 2)
      fail(403, "Write access required");
    if (sourceBranch === targetBranch) fail(400, "Select different branches");
    const [left, right] = await Promise.all([
      h.engine(
        c,
        target,
        "/resolve?ref=" + encodeURIComponent("refs/heads/" + sourceBranch),
      ),
      h.engine(
        c,
        target,
        "/resolve?ref=" + encodeURIComponent("refs/heads/" + targetBranch),
      ),
    ]);
    return { source_sha: left.sha, target_sha: right.sha };
  };
  app.post(base + "/merges", async (c) => {
    const target = await access(c),
      user = identity(c),
      b = z
        .object({
          title: z.string().trim().min(1).max(240),
          body: z.string().max(20000).default(""),
          source: branch,
          target: branch,
        })
        .parse(await jsonInput(c));
    const snapshot = await snapshotFor(c, target, b.source, b.target);
    const mr = await c.env.DB.prepare(
      "INSERT INTO merge_requests(repo_id,author_id,title,body,source,target,source_sha,target_sha,source_namespace,source_name) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM repositories WHERE id=? AND deleted_at IS NULL) RETURNING *",
    )
      .bind(
        target.id,
        user.id,
        b.title,
        b.body,
        b.source,
        b.target,
        snapshot.source_sha,
        snapshot.target_sha,
        target.namespace,
        target.name,
        target.id,
      )
      .first();
    if (!mr) fail(409, "Target repository changed");
    await h.audit(c, "merge_request.create", target.id, b.title);
    return c.json(mr, 201);
  });
  const discussionPage = async (
    c: Context<App>,
    mrId: number,
    cursor: string | undefined,
  ) => {
    const after = Number(cursor || 0);
    if (!Number.isSafeInteger(after) || after < 0)
      fail(400, "Invalid discussion cursor");
    const rows = await c.env.DB.prepare(
      "SELECT d.rowid AS cursor,d.*,u.username AS author,(SELECT COUNT(*) FROM merge_discussion_comments WHERE discussion_id=d.id) AS comments_count FROM merge_discussions d JOIN users u ON u.id=d.author_id WHERE d.mr_id=? AND d.rowid>? ORDER BY d.rowid LIMIT 100",
    )
      .bind(mrId, after)
      .all<any>();
    return {
      discussions: rows.results,
      next: rows.results.length === 100 ? rows.results.at(-1).cursor : null,
    };
  };
  app.get(base + "/merges/:id", async (c) => {
    const { repo, mr } = await mrFor(c);
    const [comparison, context, discussions] = await Promise.all([
      h.engine(
        c,
        repo,
        `/compare?source=${mr.source_sha}&target=${mr.target_sha}`,
      ),
      h.engine(c, repo, `/review-context?id=${mr.id}&revision=${mr.revision}`),
      discussionPage(c, mr.id, c.req.query("discussions_after")),
    ]);
    let stale = false;
    try {
      const [source, target] = await Promise.all([
        h.engine(
          c,
          repo,
          "/resolve?ref=" + encodeURIComponent("refs/heads/" + mr.source),
        ),
        h.engine(
          c,
          repo,
          "/resolve?ref=" + encodeURIComponent("refs/heads/" + mr.target),
        ),
      ]);
      stale = source.sha !== mr.source_sha || target.sha !== mr.target_sha;
    } catch {
      stale = true;
    }
    return c.json({
      ...mr,
      diff: comparison.diff,
      discussions: discussions.discussions,
      discussions_next: discussions.next,
      closing_issues: context.closing_issues,
      gate: { ...context.gate, allowed: context.gate.allowed && !stale },
      stale,
    });
  });
  app.post(base + "/merges/:id/reviews", async (c) => {
    const { repo, mr } = await mrFor(c, "read"),
      user = identity(c),
      b = z
        .object({
          verdict: z.enum(["approve", "changes", "comment"]),
          body: z.string().max(20000).default(""),
          source_sha: sha,
          target_sha: sha,
        })
        .parse(await jsonInput(c));
    const row = await h.engine(c, repo, "/review-submit", {
      ...b,
      id: mr.id,
      actor_id: user.id,
    });
    await h.audit(c, "merge_request.review", repo.id, String(mr.id));
    return c.json(row, 201);
  });
  app.patch(base + "/merges/:id", async (c) => {
    const { repo, mr } = await mrFor(c, "read"),
      u = identity(c);
    if (u.id !== mr.author_id && roleRank[c.get("repoRole")] < 3)
      fail(403, "Author or maintainer required");
    if (mr.state === "merged") fail(409, "Already merged");
    const b = z
      .object({
        state: z.enum(["open", "closed"]).optional(),
        refresh: z.boolean().optional(),
        revision: z.number().int().min(0).optional(),
        title: z.string().trim().min(1).max(240).optional(),
        body: z.string().max(20000).optional(),
      })
      .parse(await jsonInput(c));
    let source = mr.source_sha,
      target = mr.target_sha;
    if (b.refresh) {
      const snapshot = await snapshotFor(c, repo, mr.source, mr.target);
      source = snapshot.source_sha;
      target = snapshot.target_sha;
    }
    await h.engine(c, repo, "/review-update", {
      id: mr.id,
      actor_id: u.id,
      ...b,
      revision: b.revision ?? mr.revision,
      source_sha: source,
      target_sha: target,
    });
    await h.audit(c, "merge_request.update", repo.id, String(mr.id));
    return c.json({ ok: true });
  });
  app.post(base + "/merges/:id/merge", async (c) => {
    const { repo, mr } = await mrFor(c, "maintain");
    const b =
      c.req.header("content-length") === "0" || !c.req.raw.body
        ? {}
        : await jsonInput(c);
    const options = z
      .object({
        strategy: z
          .enum(["ff_prefer", "ff_only", "merge"])
          .default("ff_prefer"),
        squash: z.boolean().default(false),
        revision: z.number().int().min(0).optional(),
      })
      .parse(b);
    const result = await h.engine(c, repo, "/review-merge", {
      id: mr.id,
      ...options,
      revision: options.revision ?? mr.revision,
      actor_id: identity(c).id,
      source_sha: mr.source_sha,
    });
    await h.audit(c, "merge_request.merge", repo.id, String(mr.id));
    return c.json(result);
  });
  app.get(base + "/merges/:id/discussions", async (c) => {
    const { mr } = await mrFor(c);
    return c.json(await discussionPage(c, mr.id, c.req.query("after")));
  });
  app.post(base + "/merges/:id/discussions", async (c) => {
    const { repo, mr } = await mrFor(c),
      user = identity(c),
      b = await jsonInput(c);
    const result = await h.engine(c, repo, "/review-discussion", {
      ...b,
      id: mr.id,
      actor_id: user.id,
    });
    await h.audit(c, "merge_request.discussion", repo.id, String(mr.id));
    return c.json(result, 201);
  });
  app.get(base + "/merges/:id/discussions/:discussion", async (c) => {
    const { mr } = await mrFor(c),
      thread = await c.env.DB.prepare(
        "SELECT * FROM merge_discussions WHERE id=? AND mr_id=?",
      )
        .bind(c.req.param("discussion"), mr.id)
        .first();
    if (!thread) fail(404, "Discussion not found");
    const after = Number(c.req.query("after") || 0);
    if (!Number.isSafeInteger(after) || after < 0)
      fail(400, "Invalid comment cursor");
    const comments = await c.env.DB.prepare(
      "SELECT x.*,u.username AS author FROM merge_discussion_comments x JOIN users u ON u.id=x.author_id WHERE x.discussion_id=? AND x.id>? ORDER BY x.id LIMIT 100",
    )
      .bind(c.req.param("discussion"), after)
      .all<any>();
    return c.json({
      thread,
      comments: comments.results,
      next: comments.results.length === 100 ? comments.results.at(-1).id : null,
    });
  });
  for (const [method, suffix, operation] of [
    ["post", "/comments", "/review-reply"],
    ["patch", "", "/review-resolve"],
  ] as const)
    app[method](
      base + "/merges/:id/discussions/:discussion" + suffix,
      async (c) => {
        const { repo, mr } = await mrFor(c),
          user = identity(c),
          b = await jsonInput(c);
        const result = await h.engine(c, repo, operation, {
          ...b,
          id: mr.id,
          actor_id: user.id,
          discussion: c.req.param("discussion"),
        });
        await h.audit(
          c,
          "merge_request.discussion.update",
          repo.id,
          String(mr.id),
        );
        return c.json(result, method === "post" ? 201 : 200);
      },
    );
  app.get(base + "/planning", async (c) => {
    const r = await access(c);
    const [labels, milestones] = await Promise.all([
      c.env.DB.prepare(
        "SELECT * FROM labels WHERE repo_id=? ORDER BY name LIMIT 200",
      )
        .bind(r.id)
        .all(),
      c.env.DB.prepare(
        "SELECT m.*,(SELECT count(*) FROM issues i WHERE i.milestone_id=m.id) AS total,(SELECT count(*) FROM issues i WHERE i.milestone_id=m.id AND i.state='closed') AS closed FROM milestones m WHERE repo_id=? ORDER BY title LIMIT 200",
      )
        .bind(r.id)
        .all(),
    ]);
    return c.json({ labels: labels.results, milestones: milestones.results });
  });
  app.post(base + "/labels", async (c) => {
    const r = await access(c, "write"),
      b = z
        .object({
          name: z.string().trim().min(1).max(50),
          color: z
            .string()
            .regex(/^[0-9a-fA-F]{6}$/)
            .default("64748b"),
        })
        .parse(await jsonInput(c)),
      id = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO labels(id,repo_id,name,color) VALUES(?,?,?,?)",
    )
      .bind(id, r.id, b.name, b.color)
      .run();
    return c.json({ id, ...b }, 201);
  });
  app.delete(base + "/labels/:id", async (c) => {
    const r = await access(c, "write");
    await c.env.DB.prepare("DELETE FROM labels WHERE repo_id=? AND id=?")
      .bind(r.id, c.req.param("id"))
      .run();
    return c.json({ ok: true });
  });
  const milestoneSchema = z.object({
    title: z.string().trim().min(1).max(120),
    description: z.string().max(20000).default(""),
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null),
    state: z.enum(["open", "closed"]).default("open"),
  });
  app.post(base + "/milestones", async (c) => {
    const r = await access(c, "write"),
      b = milestoneSchema.parse(await jsonInput(c)),
      id = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO milestones(id,repo_id,title,description,due_date,state) VALUES(?,?,?,?,?,?)",
    )
      .bind(id, r.id, b.title, b.description, b.due_date, b.state)
      .run();
    return c.json({ id, ...b }, 201);
  });
  app.patch(base + "/milestones/:id", async (c) => {
    const r = await access(c, "write"),
      b = z
        .object({
          title: z.string().trim().min(1).max(120).optional(),
          description: z.string().max(20000).optional(),
          due_date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable()
            .optional(),
          state: z.enum(["open", "closed"]).optional(),
        })
        .parse(await jsonInput(c));
    const old = await c.env.DB.prepare(
      "SELECT * FROM milestones WHERE id=? AND repo_id=?",
    )
      .bind(c.req.param("id"), r.id)
      .first<any>();
    if (!old) fail(404, "Milestone not found");
    const next = { ...old, ...b };
    await c.env.DB.prepare(
      "UPDATE milestones SET title=?,description=?,due_date=?,state=? WHERE id=? AND repo_id=?",
    )
      .bind(
        next.title,
        next.description,
        next.due_date,
        next.state,
        old.id,
        r.id,
      )
      .run();
    return c.json({ ok: true });
  });
  app.get(base + "/releases", async (c) => {
    const r = await access(c);
    return c.json({
      releases: (
        await c.env.DB.prepare(
          "SELECT x.*,u.username AS author FROM releases x JOIN users u ON u.id=x.author_id WHERE repo_id=? ORDER BY created_at DESC LIMIT 100",
        )
          .bind(r.id)
          .all()
      ).results,
    });
  });
  app.post(base + "/releases", async (c) => {
    const r = await access(c, "maintain"),
      u = identity(c),
      b = z
        .object({
          tag: branch,
          title: z.string().trim().min(1).max(200),
          body: z.string().max(20000).default(""),
          prerelease: z.boolean().default(false),
        })
        .parse(await jsonInput(c));
    const commit = await h.engine(
      c,
      r,
      "/resolve?ref=" + encodeURIComponent("refs/tags/" + b.tag),
    );
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO releases(id,repo_id,tag,sha,title,body,prerelease,author_id) VALUES(?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        r.id,
        b.tag,
        commit.sha || commit.commit_sha,
        b.title,
        b.body,
        +b.prerelease,
        u.id,
      )
      .run();
    await h.audit(c, "release.create", r.id, b.tag);
    return c.json({ id, ...b }, 201);
  });
  app.delete(base + "/releases/:id", async (c) => {
    const r = await access(c, "maintain");
    await c.env.DB.prepare("DELETE FROM releases WHERE repo_id=? AND id=?")
      .bind(r.id, c.req.param("id"))
      .run();
    await h.audit(c, "release.delete", r.id, c.req.param("id"));
    return c.json({ ok: true });
  });
  registerCommunity(app, h, access);
}
function registerCommunity(
  app: Hono<App>,
  h: Helpers,
  access: Helpers["access"],
) {
  const base = "/api/repos/:namespace/:repo";
  app.get(base + "/wiki", async (c) => {
    const r = await access(c);
    return c.json({
      pages: (
        await c.env.DB.prepare(
          "SELECT slug,title,version,updated_at FROM wiki_pages WHERE repo_id=? ORDER BY title LIMIT 200",
        )
          .bind(r.id)
          .all()
      ).results,
    });
  });
  app.get(base + "/wiki/:page", async (c) => {
    const r = await access(c);
    const version = c.req.query("version");
    const row = version
      ? await c.env.DB.prepare(
          "SELECT * FROM wiki_history WHERE repo_id=? AND slug=? AND version=?",
        )
          .bind(r.id, c.req.param("page"), Number(version))
          .first()
      : await c.env.DB.prepare(
          "SELECT * FROM wiki_pages WHERE repo_id=? AND slug=?",
        )
          .bind(r.id, c.req.param("page"))
          .first();
    if (!row) fail(404, "Wiki page not found");
    return c.json({
      ...row,
      history: (
        await c.env.DB.prepare(
          "SELECT version,title,created_at FROM wiki_history WHERE repo_id=? AND slug=? ORDER BY version DESC LIMIT 100",
        )
          .bind(r.id, c.req.param("page"))
          .all()
      ).results,
    });
  });
  app.put(base + "/wiki/:page", async (c) => {
    const r = await access(c, "write"),
      u = identity(c),
      page = slug.parse(c.req.param("page")),
      b = z
        .object({
          title: z.string().trim().min(1).max(200),
          body: z.string().max(100000),
          expected_version: z.number().int().min(0),
        })
        .parse(await jsonInput(c));
    const result = await c.env.DB.prepare(
      "INSERT INTO wiki_pages(repo_id,slug,title,body,version,author_id) SELECT ?,?,?,?,1,? WHERE ?=0 ON CONFLICT(repo_id,slug) DO UPDATE SET title=excluded.title,body=excluded.body,version=wiki_pages.version+1,author_id=excluded.author_id,updated_at=datetime('now') WHERE wiki_pages.version=? RETURNING version",
    )
      .bind(
        r.id,
        page,
        b.title,
        b.body,
        u.id,
        b.expected_version,
        b.expected_version,
      )
      .first<any>();
    if (!result) {
      if (b.expected_version > 0) {
        const update = await c.env.DB.prepare(
          "UPDATE wiki_pages SET title=?,body=?,version=version+1,author_id=?,updated_at=datetime('now') WHERE repo_id=? AND slug=? AND version=? RETURNING version",
        )
          .bind(b.title, b.body, u.id, r.id, page, b.expected_version)
          .first<any>();
        if (!update) fail(409, "Wiki changed; reload before saving");
        await h.audit(c, "wiki.update", r.id, page);
        return c.json(update);
      }
      fail(409, "Wiki changed; reload before saving");
    }
    await h.audit(c, "wiki.update", r.id, page);
    return c.json(result);
  });
}
