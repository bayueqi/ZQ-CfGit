export interface Env {
  DB: D1Database;
  OBJECTS: R2Bucket;
  REPOSITORIES: DurableObjectNamespace;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  BOOTSTRAP_SECRET: string;
  LEGACY_APP_ORIGIN?: string;
}
export interface User {
  id: string;
  username: string;
  admin: number;
}
export interface Repo {
  id: string;
  owner_id: string;
  workspace_id?: string | null;
  namespace: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  default_branch: string;
  created_at: string;
  deleted_at?: string | null;
  archived_at?: string | null;
  lifecycle_revision?: number;
  base_repo?: string | null;
}
export type App = {
  Bindings: Env;
  Variables: {
    user: User | null;
    repoRole: string;
    scope: "read" | "write";
    kind: "pat" | "session" | "jwt" | null;
    delegation?: import("./delegation").Delegation;
    credential: string | null;
  };
};
