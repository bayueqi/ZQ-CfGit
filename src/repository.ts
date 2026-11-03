import { RequestGate } from "./git/request-gate";
import { BrowseCache } from "./git/browse-cache";
import { updatesAt } from "./git/tree-updates";
import {
  acquireSnapshot,
  SnapshotBudget,
  SnapshotStore,
  repositoryRead,
  snapshotRead,
  shareableOperation,
  snapshotResponse,
} from "./git/snapshot-read";
import { PackCache, collectPackCache } from "./git/pack-cache";
import { responseCompletion } from "./git/pack-stream";
import { receiveStream } from "./git/receive-stream";
import { collectIncoming } from "./git/incoming-area";
import { gitStage, reportGitFailure } from "./git/diagnostics";
import { GitObjectIndex } from "./git/object-index";
import { checkProjectVersion, withProjectTransition } from "./project-version";
import { renameProject } from "./project-transfer";
import {
  assertRepositoryWritable,
  assertProjectRevision,
  changeProjectState,
  archiveError,
} from "./project-state";
import { z } from "zod";
import { ObjectCache } from "./git/object-cache";
import type { Repo } from "./types";
import type { RefStorage } from "./git/repository";
import { lifecycle, collectDeleted, projectDefaultBranch } from "./lifecycle";
import { DurableObject } from "cloudflare:workers";
import { HTTPException } from "hono/http-exception";
import { putRefPublication } from "./git/receipts";
import type { Env } from "./types";
import { boundedBody, fail, branch, repoName } from "./security";
import { ObjectStore, Refs, text } from "./git/objects";
import { namespaceRepositories } from "./git/namespaces";
import { advertise, upload } from "./git/protocol";
import { importSnapshot } from "./git/legacy";
/** The per-repository DO serializes requests; immutable R2 objects precede atomic ref publication. */
export class Repository extends DurableObject<Env> {
  private gate = new RequestGate();
  private get waiting() {
    return this.gate.waiting;
  }
  private objectCache = new ObjectCache();
  private objectIndex?: GitObjectIndex;
  async fetch(request: Request): Promise<Response> {
    const started = performance.now();
    let admitted = started;
    try {
      // Internal cross-fork queue checks never wait on the other repository's writer gate.
      // Only published refs are visible; no R2 reads or nested source locks are acquired.
      if (
        request.method === "GET" &&
        new URL(request.url).pathname === "/internal/queue-source"
      ) {
        const id = request.headers.get("x-repo-id") || "";
        if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, "Invalid repository");
        if (await this.ctx.storage.get("deleted"))
          fail(404, "Repository deleted");
        await checkProjectVersion(this.env, this.ctx.storage, id, request);
        const ref = new URL(request.url).searchParams.get("ref") || "";
        if (!ref.startsWith("refs/heads/")) fail(400, "Branch required");
        branch.parse(ref.slice(11));
        const refs = (await this.ctx.storage.get<Refs>("refs.v2")) || {};
        return Response.json({ sha: refs[ref] || null });
      }
      const response = await this.gate.run(
        shareableOperation(request),
        async (ready) => {
          admitted = performance.now();
          return this.handle(request, ready);
        },
        snapshotRead(request)
          ? async () => {
              admitted = performance.now();
              return this.handleSnapshot(request);
            }
          : undefined,
      );
      if (new URL(request.url).pathname === "/browse") {
        response.headers.append(
          "Server-Timing",
          `repo_queue;dur=${(admitted - started).toFixed(1)}, repo_total;dur=${(performance.now() - started).toFixed(1)}`,
        );
      }
      return response;
    } catch (e) {
      if (e instanceof HTTPException)
        return Response.json({ error: e.message }, { status: e.status });
      if (archiveError(e))
        return Response.json({ error: "Repository archived" }, { status: 409 });
      const incident = reportGitFailure(
        e,
        request.headers.get("x-repo-id") || "",
        "repository",
      );
      return Response.json(
        {
          error:
            "Git transaction failed; inspect refs before retrying; incident " +
            incident,
          incident_id: incident,
        },
        { status: 503, headers: { "X-ZQ-CfGit-Incident": incident } },
      );
    }
  }
  async alarm() {
    // An alarm has a 15-minute wall-clock budget. Never spend it waiting for an HTTP stream.
    if (this.waiting) {
      await this.ctx.storage.setAlarm(Date.now() + 30000);
      return;
    }
    await this.gate.run(false, async () => {
      if (await this.ctx.storage.get("deleted")) {
        this.objectCache.clear();
        await collectDeleted(this.env, this.ctx.storage);
        return new Response(null, { status: 204 });
      }
      await projectDefaultBranch(this.env, this.ctx.storage);
      try {
        await collectPackCache(this.env.OBJECTS, this.ctx.storage);
      } catch {
        // A disposable cache must not stall event delivery or upstream reconciliation.
        await this.ctx.storage.setAlarm(Date.now() + 30000);
      }
      const incomingPending = await collectIncoming(
        this.env.OBJECTS,
        this.ctx.storage,
      );
      if (incomingPending) await this.ctx.storage.setAlarm(Date.now() + 1000);
      return new Response(null, { status: 204 });
    });
  }
  private async handleSnapshot(
    request: Request,
  ): Promise<Response | undefined> {
    const release = acquireSnapshot();
    if (!release) return;
    let store: SnapshotStore | undefined, completion: Promise<void> | undefined;
    const id = request.headers.get("x-repo-id") || "";
    try {
      if (!/^[0-9a-f-]{36}$/.test(id) || this.objectIndex?.repoId !== id)
        fail(400, "Invalid repository");
      if (await this.ctx.storage.get("deleted"))
        fail(404, "Repository deleted");
      const version = await this.ctx.storage.get<number>("project-version");
      if (
        version === undefined ||
        (await this.ctx.storage.get("project-transition"))
      )
        throw new SnapshotBudget();
      if (
        request.headers.has("x-lifecycle-revision") &&
        request.headers.get("x-lifecycle-revision") !== String(version)
      )
        fail(
          409,
          "Project moved or lifecycle changed; reload before reading or writing",
        );
      const ephemeral = request.headers.get("x-namespace") === "ephemeral";
      const defaultBranch = branch.parse(
        (await this.ctx.storage.get<string>("default-branch")) ||
          request.headers.get("x-default-branch") ||
          "main",
      );
      const refs = (await this.ctx.storage.get<Refs>("refs.v2")) || {};
      store = new SnapshotStore(id, this.env.OBJECTS, this.objectCache);
      const readonlyStorage: RefStorage = {
        get: <T>(key: string) => this.ctx.storage.get<T>(key),
        put: async () => {
          throw Error("Snapshot attempted ref publication");
        },
      };
      const repo = namespaceRepositories(
        store,
        readonlyStorage,
        refs,
        defaultBranch,
        {},
      )(ephemeral);
      // Explicit unpublished/ancestry selectors retain their existing serialized API semantics.
      const query = new URL(request.url).searchParams;
      for (const selector of [query.get("ref"), query.get("sha")]) {
        if (!selector) continue;
        if (
          /[~^]/.test(selector) ||
          /^[0-9a-f]{4,39}$/.test(selector) ||
          (/^[0-9a-f]{40}$/.test(selector) &&
            !Object.values(repo.refs).includes(selector))
        )
          throw new SnapshotBudget();
      }
      const result = await repositoryRead(
        repo,
        request,
        defaultBranch,
        new BrowseCache(this.ctx.storage, false),
      );
      if (!result) throw new SnapshotBudget();
      const response = await snapshotResponse(result);
      completion = responseCompletion(response);
      return response;
    } catch (error) {
      if (error instanceof SnapshotBudget) return;
      throw error;
    } finally {
      await store?.close();
      if (completion)
        this.ctx.waitUntil(
          completion.then(() => {
            release();
            console.info("Git snapshot drained", {
              repoId: id,
              ...store?.ioUsage,
            });
          }),
        );
      else release();
    }
  }
  private async handle(request: Request, ready: () => void = () => {}) {
    const id = request.headers.get("x-repo-id") || "";
    if (!/^[0-9a-f-]{36}$/.test(id)) fail(400, "Invalid repository");
    if (await this.ctx.storage.get("deleted")) fail(404, "Repository deleted");
    await gitStage("metadata", () =>
      checkProjectVersion(this.env, this.ctx.storage, id, request),
    );
    const defaultBranch = branch.parse(
      (await this.ctx.storage.get<string>("default-branch")) ||
        request.headers.get("x-default-branch") ||
        "main",
    );
    const url = new URL(request.url),
      store = new ObjectStore(
        id,
        this.env.OBJECTS,
        this.objectCache,
        (this.objectIndex ||= await gitStage(
          "object-index",
          async () => new GitObjectIndex(id, this.ctx.storage),
        )),
      );
    // Public API access was checked against fresh D1 metadata by the outer Worker.
    // Reads use durable refs/tombstone and the recoverable version cache; mutations also load authoritative metadata.
    const metadata =
      ["GET", "HEAD"].includes(request.method) &&
      url.searchParams.get("service") !== "git-receive-pack"
        ? null
        : await gitStage("metadata", () =>
            this.env.DB.prepare(
              "SELECT * FROM repositories WHERE id=? AND deleted_at IS NULL",
            )
              .bind(id)
              .first<Repo>(),
          );
    if (metadata || !["GET", "HEAD"].includes(request.method))
      assertProjectRevision(metadata, request);
    assertRepositoryWritable(metadata, request);
    if (
      ["/internal/lifecycle", "/internal/transfer"].includes(url.pathname) &&
      request.method === "POST"
    ) {
      if (!metadata) fail(404, "Repository not found");
      const body = z
        .object({
          actor_id: z.string(),
          archived: z.boolean().optional(),
          name: repoName.optional(),
          revision: z.number().int().min(0),
        })
        .parse(JSON.parse(text(await boundedBody(request, 4096))));
      if (url.pathname === "/internal/transfer") {
        if (!body.name) fail(400, "Destination name required");
        return Response.json(
          await withProjectTransition(this.env, this.ctx.storage, id, () =>
            renameProject(
              this.env,
              metadata,
              body.actor_id,
              body.name!,
              body.revision,
            ),
          ),
        );
      }
      if (body.archived === undefined) fail(400, "Archived state required");
      return Response.json(
        await withProjectTransition(this.env, this.ctx.storage, id, () =>
          changeProjectState(
            this.env,
            id,
            body.actor_id,
            body.archived!,
            body.revision,
          ),
        ),
      );
    }
    let refs = await this.ctx.storage.get<Refs>("refs.v2");
    if (!refs) {
      const legacy = await this.ctx.storage.get<string>("snapshot");
      if (legacy) {
        const snapshot = await this.env.OBJECTS.get(legacy);
        if (!snapshot) fail(503, "Legacy snapshot missing; restore backup");
        if (snapshot.size > 24 * 1024 * 1024)
          fail(413, "Legacy snapshot exceeds migration limit");
        refs = await importSnapshot(
          new Uint8Array(await snapshot.arrayBuffer()),
          store,
          this.ctx.storage,
        );
      } else refs = {};
    }
    ready();
    const publication: RefStorage = {
      get: <T>(key: string) => this.ctx.storage.get<T>(key),
      put: async (key, value) => {
        // Snapshot import staging is repository-scoped state, not a ref publication.
        if (key.startsWith("import:")) {
          await this.ctx.storage.put(key, value);
          return;
        }
        if (key !== "refs.v2") fail(400, "Unexpected Git state key");
        const values: Record<string, unknown> = { "refs.v2": value as Refs };
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        await putRefPublication(this.ctx.storage, values);
      },
    };
    const select = namespaceRepositories(
      store,
      publication,
      refs,
      defaultBranch,
      {},
    );
    const ephemeral = request.headers.get("x-namespace") === "ephemeral",
      repo = select(ephemeral),
      path = url.pathname;
    const life = await lifecycle(request, repo, this.env, this.ctx.storage);
    if (life) return life;
    const q = Object.fromEntries(url.searchParams);
    if (request.method === "GET" && path === "/tree-updates")
      return Response.json(
        await updatesAt(
          repo,
          q.ref || defaultBranch,
          q.path || "",
          this.ctx.storage,
        ),
      );
    const sharedRead = await repositoryRead(
      repo,
      request,
      defaultBranch,
      new BrowseCache(this.ctx.storage),
    );
    if (sharedRead) return sharedRead;
    if (request.method === "GET") {
      switch (path) {
        case "/diff":
          return Response.json(
            await repo.diff(q.sha || q.ref || "HEAD", q.base, {
              paths: url.searchParams.getAll("path"),
            }),
          );
      }
    }
    if (
      ["POST", "DELETE"].includes(request.method) &&
      [
        "/branches/create",
        "/branches/delete",
        "/tags/create",
        "/tags/delete",
        "/archive",
      ].includes(path)
    ) {
      let body;
      try {
        body = JSON.parse(text(await boundedBody(request, 12 * 1024 * 1024)));
      } catch (e) {
        if (e instanceof HTTPException) throw e;
        fail(400, "Invalid JSON");
      }
      const target = select(
        body.ephemeral === true ||
          body.target_is_ephemeral === true ||
          ephemeral,
      );
      switch (path) {
        case "/branches/create":
          return Response.json(await target.createBranch(body), {
            status: 201,
          });
        case "/branches/delete":
          return Response.json(
            await target.deleteBranch(
              body.branch || body.name,
              body.expected_sha,
            ),
          );
        case "/tags/create":
          return Response.json(
            await target.createTag(body.name, body.ref || body.sha),
            { status: 201 },
          );
        case "/tags/delete":
          return Response.json(await target.deleteTag(body.name));
        case "/archive":
          return target.archive(body);
      }
    }
    if (request.method === "POST" && path === "/import-files") {
      let body;
      try {
        body = JSON.parse(
          text(await boundedBody(request, 32 * 1024 * 1024)),
        );
      } catch (e) {
        if (e instanceof HTTPException) throw e;
        fail(400, "Invalid JSON");
      }
      return Response.json(await repo.replaceSnapshot(body), { status: 201 });
    }
    if (request.method === "POST" && path === "/import-blob-ref") {
      let ref;
      try {
        ref = JSON.parse(text(await boundedBody(request, 64 * 1024)));
      } catch (e) {
        if (e instanceof HTTPException) throw e;
        fail(400, "Invalid JSON");
      }
      return Response.json(await repo.stageBlobRef(ref), { status: 201 });
    }
    if (path === "/git/info/refs" && request.method === "GET") {
      const service = url.searchParams.get("service") || "";
      if (!["git-upload-pack", "git-receive-pack"].includes(service))
        fail(400, "Unsupported Git service");
      return advertise(
        repo,
        service,
        (request.headers.get("git-protocol") || "")
          .split(":")
          .includes("version=2"),
      );
    }
    if (path === "/git/git-receive-pack" && request.method === "POST") {
      return receiveStream(repo, request, this.env.OBJECTS, this.ctx.storage);
    }
    if (path === "/git/git-upload-pack" && request.method === "POST") {
      const packCache = new PackCache(id, this.env.OBJECTS, this.ctx.storage);
      const response = await upload(
        repo,
        await boundedBody(request, 1024 * 1024),
        packCache,
      );
      const completion = responseCompletion(response);
      if (completion)
        this.ctx.waitUntil(
          completion.then(() => {
            console.info("Git transfer drained", {
              repoId: id,
              ...store.ioUsage,
              packCache: packCache.metrics,
            });
          }),
        );
      return response;
    }
    if (request.method === "GET") {
      const ref = url.searchParams.get("ref") || "HEAD";
      switch (path) {
        case "/search":
          return Response.json(
            await repo.search(ref, url.searchParams.get("q") || ""),
          );
      }
    }
    if (request.method === "POST" && path === "/commit") {
      let body;
      try {
        body = JSON.parse(text(await boundedBody(request, 2 * 1024 * 1024)));
      } catch (e) {
        if (e instanceof HTTPException) throw e;
        fail(400, "Invalid JSON");
      }
      return Response.json(await repo.commit(body), { status: 201 });
    }
    fail(404, "Git endpoint not found");
  }
}
