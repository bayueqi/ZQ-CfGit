import type { Env, Repo } from "./types";
import { fail, branch, boundedBody, digest } from "./security";
import type { ForgeRepository } from "./git/forge";
/** Replay the authoritative DO branch after a failed D1 projection. Caller holds the writer gate. */
export async function projectDefaultBranch(
  env: Env,
  storage: DurableObjectStorage,
) {
  const id = await storage.get<string>("default-branch-projection");
  if (!id) return;
  await storage.setAlarm(Date.now() + 1000);
  const name = await storage.get<string>("default-branch");
  if (!name) throw Error("Missing authoritative default branch");
  await env.DB.prepare(
    "UPDATE repositories SET default_branch=? WHERE id=? AND deleted_at IS NULL",
  )
    .bind(name, id)
    .run();
  await storage.delete("default-branch-projection");
}
/** Called only inside the repository's serialized request queue. */
export async function lifecycle(
  request: Request,
  repo: ForgeRepository,
  env: Env,
  storage: DurableObjectStorage,
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname,
    id = repo.store.repoId;
  if (path === "/internal/delete" && request.method === "POST") {
    // A durable tombstone rejects already-authorized in-flight requests too.
    await storage.put("deleted", id);
    await storage.setAlarm(Date.now() + 60000);
    await env.DB.prepare(
      "UPDATE repositories SET deleted_at=datetime('now'),name=? WHERE id=?",
    )
      .bind("deleted_" + id, id)
      .run();
    return Response.json({ deleted: true, cleanup: "scheduled" });
  }
  if (await storage.get("deleted")) fail(404, "Repository deleted");
  if (path === "/internal/default-branch" && request.method === "POST") {
    const body = (await request.json()) as { default_branch: string };
    const name = branch.parse(body.default_branch);
    if (Object.keys(repo.refs).length && !repo.refs["refs/heads/" + name])
      fail(409, "Default branch must exist");
    // Arm before the atomic multi-key write: a lost acknowledgement cannot strand the projection.
    await storage.setAlarm(Date.now() + 1000);
    await storage.put({
      "default-branch": name,
      "default-branch-projection": id,
    });
    await projectDefaultBranch(env, storage);
    return Response.json({ default_branch: name });
  }
  if (
    path.startsWith("/internal/lfs/") &&
    ["PUT", "GET"].includes(request.method)
  ) {
    const oid = path.slice("/internal/lfs/".length);
    if (!/^[0-9a-f]{64}$/.test(oid)) fail(400, "Invalid LFS oid");
    const metadata = await env.DB.prepare(
      "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL",
    )
      .bind(id)
      .first<Repo>();
    if (!metadata) fail(404, "Repository deleted");
    if (request.method === "GET") {
      const existing = await env.OBJECTS.get(`lfs/${id}/${oid}`);
      if (existing)
        return new Response(existing.body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(existing.size),
          },
        });
      fail(404, "LFS object missing");
    }
    const data = await boundedBody(request, 16 * 1024 * 1024);
    if ((await digest(data)) !== oid) fail(400, "LFS SHA-256 mismatch");
    await env.OBJECTS.put(`lfs/${id}/${oid}`, data);
    return Response.json({ ok: true });
  }
}
/** Retriable incremental garbage collection. Keep the tombstone permanently. */
export async function collectDeleted(env: Env, storage: DurableObjectStorage) {
  const id = await storage.get<string>("deleted");
  if (!id) return;
  // Retry the metadata retirement if the original D1 update was interrupted.
  await env.DB.prepare(
    "UPDATE repositories SET deleted_at=COALESCE(deleted_at,datetime('now')),name=? WHERE id=?",
  )
    .bind("deleted_" + id, id)
    .run();
  for (const prefix of [`repos/${id}/`, `lfs/${id}/`]) {
    const page = await env.OBJECTS.list({ prefix, limit: 100 });
    if (page.objects.length) {
      await env.OBJECTS.delete(page.objects.map((o) => o.key));
      await storage.setAlarm(Date.now() + 1000);
      return;
    }
  }
  await env.DB.prepare(
    "DELETE FROM repositories WHERE id=? AND deleted_at IS NOT NULL",
  )
    .bind(id)
    .run();
  storage.sql?.exec(
    "DROP TABLE IF EXISTS git_edges_v1; DROP TABLE IF EXISTS git_objects_v1; DROP TABLE IF EXISTS git_index_owner_v1; DROP TABLE IF EXISTS git_walk_excluded_v1;",
  );
  await storage.delete([
    "refs.v2",
    "snapshot",
    "default-branch",
    "browse-root.v1:ordinary",
    "browse-root.v1:ephemeral",
    "browse-warmed.v1",
    "tree-updates.v1:ordinary",
    "tree-updates.v1:ephemeral",
  ]);
  const incoming = await storage.list({ prefix: "incoming:" });
  if (incoming.size) await storage.delete([...incoming.keys()]);
  const packCache = await storage.list({ prefix: "pack-cache:" });
  if (packCache.size) await storage.delete([...packCache.keys()]);
  const updates = await storage.list({ prefix: "tree-updates.v1:" });
  if (updates.size) await storage.delete([...updates.keys()]);
}
