import type { Env, Repo } from "./types";
import { repositoryRole, roleRank } from "./access";
import type { ObjectStore } from "./git/objects";
export async function reviewGate(
  env: Env,
  repo: Repo,
  mr: any,
  _store?: ObjectStore,
) {
  const reviews = (
    await env.DB.prepare(
      "SELECT v.*,u.username,u.admin,u.disabled FROM merge_reviews v JOIN users u ON u.id=v.user_id WHERE mr_id=? ORDER BY v.id DESC LIMIT 200",
    )
      .bind(mr.id)
      .all<any>()
  ).results;
  const seen = new Set<string>();
  let approvals = 0,
    changes = 0;
  const decisions = (
    await env.DB.prepare(
      "SELECT v.*,u.username,u.admin,u.disabled FROM merge_reviews v JOIN users u ON u.id=v.user_id WHERE v.mr_id=? AND v.source_sha=? AND v.target_sha=? AND v.verdict!='comment' AND NOT EXISTS(SELECT 1 FROM merge_reviews newer WHERE newer.mr_id=v.mr_id AND newer.user_id=v.user_id AND newer.source_sha=v.source_sha AND newer.target_sha=v.target_sha AND newer.verdict!='comment' AND newer.id>v.id)",
    )
      .bind(mr.id, mr.source_sha, mr.target_sha)
      .all<any>()
  ).results;
  for (const r of decisions) {
    if (
      r.verdict === "comment" ||
      r.source_sha !== mr.source_sha ||
      r.target_sha !== mr.target_sha ||
      r.user_id === mr.author_id ||
      r.disabled ||
      seen.has(r.user_id)
    )
      continue;
    seen.add(r.user_id);
    if (
      roleRank[
        await repositoryRole(env, repo, {
          id: r.user_id,
          username: r.username,
          admin: r.admin,
        })
      ] < 2
    )
      continue;
    if (r.verdict === "approve") approvals++;
    else changes++;
  }
  const unresolved =
    (
      await env.DB.prepare(
        "SELECT count(*) AS n FROM merge_discussions d JOIN users u ON u.id=d.author_id WHERE d.mr_id=? AND d.resolved=0 AND u.disabled=0 AND ((? IS NULL AND u.id=?) OR EXISTS(SELECT 1 FROM members m WHERE m.repo_id=? AND m.user_id=u.id AND m.role IN('developer','maintainer','owner')) OR EXISTS(SELECT 1 FROM workspace_members w WHERE w.workspace_id=? AND w.user_id=u.id AND w.role IN('developer','maintainer','owner')))",
      )
        .bind(
          mr.id,
          repo.workspace_id || null,
          repo.owner_id,
          repo.id,
          repo.workspace_id || null,
        )
        .first<{ n: number }>()
    )?.n || 0;
  const reasons: string[] = [];
  if (changes) reasons.push("Reviewer requested changes");
  return {
    unresolved,
    approvals,
    changes,
    ci: null,
    reviews: reviews.map(({ admin, disabled, ...review }) => review),
    reasons,
    allowed: !reasons.length,
  };
}
