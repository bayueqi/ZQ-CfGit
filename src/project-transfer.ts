import type { Env, Repo } from "./types";
import { fail } from "./security";
/** Renames a repository in place. The previous address is kept as an alias so old URLs keep working. */
export async function renameProject(
  env: Env,
  repo: Repo,
  actor: string,
  name: string,
  revision: number,
) {
  if (repo.name === name) fail(400, "Project already has this address");
  const guard = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mutation_guards(id,accepted) SELECT ?,CASE WHEN EXISTS(
        SELECT 1 FROM repositories r JOIN users u ON u.id=? WHERE r.id=? AND r.deleted_at IS NULL AND u.disabled=0 AND r.lifecycle_revision=? AND r.owner_id=u.id
        ) THEN 1 ELSE 0 END`,
      ).bind(guard, actor, repo.id, revision),
      env.DB.prepare(
        "DELETE FROM repository_aliases WHERE namespace=? AND name=? AND repo_id=?",
      ).bind(repo.namespace, name, repo.id),
      env.DB.prepare(
        "INSERT INTO repository_aliases(namespace,name,repo_id) SELECT namespace,name,id FROM repositories WHERE id=?",
      ).bind(repo.id),
      env.DB.prepare(
        "UPDATE repositories SET name=?,lifecycle_revision=lifecycle_revision+1 WHERE id=?",
      ).bind(name, repo.id),
      env.DB.prepare("DELETE FROM mutation_guards WHERE id=?").bind(guard),
    ]);
  } catch (error) {
    if (error instanceof Error && /CHECK constraint failed/.test(error.message))
      fail(409, "Project or ownership changed; reload before renaming");
    if (
      error instanceof Error &&
      /UNIQUE constraint failed|Repository address reserved/.test(error.message)
    )
      fail(409, "Destination address is already in use or reserved");
    throw error;
  }
  return env.DB.prepare("SELECT * FROM repositories WHERE id=?")
    .bind(repo.id)
    .first<Repo>();
}
export async function repositoryAt(env: Env, namespace: string, name: string) {
  const direct = await env.DB.prepare(
    "SELECT * FROM repositories WHERE namespace=? AND name=? AND deleted_at IS NULL",
  )
    .bind(namespace, name)
    .first<Repo>();
  if (direct) return { repo: direct, moved: false };
  const moved = await env.DB.prepare(
    "SELECT r.* FROM repositories r JOIN repository_aliases a ON a.repo_id=r.id WHERE a.namespace=? AND a.name=? AND r.deleted_at IS NULL",
  )
    .bind(namespace, name)
    .first<Repo>();
  return moved ? { repo: moved, moved: true } : null;
}
