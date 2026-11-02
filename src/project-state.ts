import type { Env, Repo } from "./types";
import { fail } from "./security";
/** Read-only POSTs do not mutate the source project. Access revocation remains available. */
export function archivedApiWrite(method: string, operation: string) {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return false;
  if (["lifecycle", "transfer"].includes(operation))
    return false;
  if (operation === "" && method === "DELETE") return false;
  if (/^members(?:\/|$)/.test(operation)) return false;
  if (method === "POST" && operation === "archive") return false;
  return true;
}
/** Executed after entering the repository DO queue, before any mutation. */
export function assertRepositoryWritable(repo: Repo | null, request: Request) {
  if (!repo?.archived_at) return;
  const url = new URL(request.url),
    path = url.pathname;
  if (
    path === "/internal/delete" ||
    path === "/internal/lifecycle" ||
    path === "/internal/transfer"
  )
    return;
  if (
    ["GET", "HEAD"].includes(request.method) &&
    url.searchParams.get("service") !== "git-receive-pack"
  )
    return;
  if (
    request.method === "POST" &&
    ["/archive", "/git/git-upload-pack"].includes(path)
  )
    return;
  fail(409, "Repository archived; an owner must unarchive it before writing");
}
export function archiveError(error: unknown) {
  return error instanceof Error && /Repository archived/.test(error.message);
}
/** Called inside the same serialized DO queue as Git publication. D1 is the durable archive barrier. */
export async function changeProjectState(
  env: Env,
  repoId: string,
  actorId: string,
  archived: boolean,
  revision: number,
) {
  const guard = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN EXISTS(
        SELECT 1 FROM repositories r JOIN users u ON u.id=? WHERE r.id=? AND r.deleted_at IS NULL AND u.disabled=0 AND r.lifecycle_revision=? AND (
          (r.workspace_id IS NULL AND r.owner_id=u.id) OR EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=r.workspace_id AND wm.user_id=u.id AND wm.role='owner')
        )) THEN 1 ELSE 0 END`,
      ).bind(guard, actorId, repoId, revision),
      env.DB.prepare(
        "UPDATE repositories SET archived_at=CASE WHEN ?=1 THEN COALESCE(archived_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE NULL END,lifecycle_revision=lifecycle_revision+1 WHERE id=?",
      ).bind(archived ? 1 : 0, repoId),
      env.DB.prepare(
        "INSERT INTO audit(repo_id,actor_id,action,detail) VALUES(?,?,?,?)",
      ).bind(
        repoId,
        actorId,
        archived ? "repo.archive" : "repo.unarchive",
        String(revision + 1),
      ),
      env.DB.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
    ]);
  } catch (error) {
    if (error instanceof Error && /CHECK constraint failed/.test(error.message))
      fail(409, "Project state or ownership changed; reload before retrying");
    throw error;
  }
  return env.DB.prepare(
    "SELECT id,archived_at,lifecycle_revision FROM repositories WHERE id=?",
  )
    .bind(repoId)
    .first();
}

/** Reject requests authorized in an earlier namespace, even if the project was subsequently restored. */
export function assertProjectRevision(repo: Repo | null, request: Request) {
  const expected = request.headers.get("x-lifecycle-revision");
  if (
    expected !== null &&
    (!repo || expected !== String(repo.lifecycle_revision || 0))
  )
    fail(409, "Project moved or lifecycle changed; reload before writing");
}
