import type { Repo, User } from "./types";
export function repositoryRole(repo: Repo, user: User | null): string {
  return user && user.id === repo.owner_id ? "owner" : "guest";
}
