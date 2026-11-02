import { type WritePolicy } from "./policy";
import { gitStage } from "./diagnostics";
import { fail } from "../security";
import {
  ObjectStore,
  Refs,
  TreeEntry,
  LIMITS,
  bytes,
  text,
  parseTree,
  treeBytes,
  parseCommit,
  validRef,
  isOid,
  checkRefs,
} from "./objects";
export interface RefStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export async function publishRefs(
  store: ObjectStore,
  storage: RefStorage,
  refs: Refs,
) {
  checkRefs(refs);
  await store.flush();
  await store.validateClosure(Object.values(refs));
  await gitStage("ref-publish", () => storage.put("refs.v2", refs));
}
export class GitRepository {
  constructor(
    readonly store: ObjectStore,
    readonly storage: RefStorage,
    public refs: Refs,
    readonly defaultBranch: string,
    readonly policy: WritePolicy = {},
  ) {}
  async publish(refs: Refs) {
    await publishRefs(this.store, this.storage, refs);
    this.refs = refs;
  }
  async resolve(ref = "HEAD") {
    return this.store.resolve(ref, this.refs, this.defaultBranch);
  }
  async root(ref = "HEAD") {
    const oid = await this.resolve(ref);
    return { oid, tree: parseCommit(await this.store.get(oid)).tree };
  }
  async entry(ref: string, path: string) {
    const { oid, tree } = await this.root(ref);
    let current: TreeEntry = {
      name: "",
      sha: tree,
      mode: "40000",
      type: "tree",
    };
    if (path) {
      this.path(path);
      for (const part of path.split("/")) {
        if (current.type !== "tree") fail(404, "Directory not found");
        const found = parseTree((await this.store.get(current.sha)).data).find(
          (e) => e.name === part,
        );
        if (!found) fail(404, "File not found");
        current = found;
      }
    }
    return { oid, entry: current };
  }
  path(path: string) {
    if (
      typeof path !== "string" ||
      !path ||
      bytes(path).length > 1000 ||
      path.startsWith("/") ||
      /[\x00-\x1f\x7f]/.test(path) ||
      path
        .split("/")
        .some(
          (p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git",
        )
    )
      fail(400, "Invalid file path");
    return path;
  }
  branch(name: string) {
    if (typeof name !== "string" || !name || !validRef("refs/heads/" + name))
      fail(400, "Invalid branch");
    return name;
  }
  async tree(ref: string, path: string) {
    const { oid, entry } = await this.entry(ref, path);
    if (entry.type !== "tree") fail(400, "Path is not a tree");
    return {
      ref: oid,
      path,
      entries: parseTree((await this.store.get(entry.sha)).data),
    };
  }
  async blob(ref: string, path: string) {
    const { oid, entry } = await this.entry(ref, this.path(path));
    if (entry.type !== "blob") fail(400, "Path is not a file");
    const object = await this.store.get(entry.sha);
    if (object.data.length > 1024 * 1024)
      fail(413, "Browser file limit is 1 MiB; use git clone");
    const binary = object.data.includes(0);
    return {
      ref: oid,
      path,
      size: object.data.length,
      binary,
      content: binary ? null : text(object.data),
    };
  }
  async commits(ref: string) {
    const pending = [await this.resolve(ref)],
      seen = new Set<string>(),
      commits = [];
    while (pending.length && commits.length < 30) {
      const sha = pending.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const c = parseCommit(await this.store.get(sha));
      const match = c.author.match(/^(.*) <[^>]*> ([0-9]+) [+-][0-9]{4}$/);
      const date = match ? new Date(Number(match[2]) * 1000) : null;
      commits.push({
        sha,
        author: match?.[1] || c.author,
        date:
          date && !Number.isNaN(date.getTime())
            ? date.toISOString()
            : new Date(0).toISOString(),
        message: c.message.split("\n")[0],
      });
      pending.push(...c.parents);
    }
    return { commits };
  }
  async files(ref: string) {
    const root = await this.root(ref),
      files = new Map<string, TreeEntry>(),
      todo = [{ sha: root.tree, path: "", depth: 0 }];
    let visited = 0;
    while (todo.length) {
      const d = todo.pop()!;
      if (d.depth > LIMITS.depth || ++visited > LIMITS.graph)
        fail(413, "Directory graph too deep or large");
      for (const entry of parseTree((await this.store.get(d.sha)).data)) {
        const p = d.path + entry.name;
        if (entry.type === "tree")
          todo.push({ sha: entry.sha, path: p + "/", depth: d.depth + 1 });
        else files.set(p, entry);
        if (files.size > LIMITS.graph) fail(413, "Too many files");
      }
    }
    return { oid: root.oid, files };
  }
  async search(ref: string, query: string) {
    if (!query || query.length > 128 || /[\r\n\0]/.test(query))
      fail(400, "Search requires 1–128 characters on one line");
    const { oid, files } = await this.files(ref),
      matches = [];
    for (const [path, e] of files) {
      if (e.type !== "blob") continue;
      const o = await this.store.get(e.sha);
      if (o.data.includes(0)) continue;
      let line = 0;
      for (const value of text(o.data).split("\n")) {
        line++;
        if (value.includes(query)) {
          if (matches.length === 200)
            return { ref: oid, matches, truncated: true };
          matches.push({ path, line, text: value.slice(0, 1000) });
        }
      }
    }
    return { ref: oid, matches, truncated: false };
  }
  private async editTree(
    tree: string | undefined,
    parts: string[],
    content: string | null,
  ): Promise<string> {
    const entries = tree ? parseTree((await this.store.get(tree)).data) : [],
      name = parts[0],
      at = entries.findIndex((e) => e.name === name),
      old = entries[at];
    if (parts.length > 1) {
      if (old && old.type !== "tree") fail(409, "File blocks directory path");
      if (!old && content === null)
        return tree || (await this.store.create("tree", new Uint8Array())).oid;
      const sha = await this.editTree(old?.sha, parts.slice(1), content);
      const child = await this.store.get(sha);
      if (child.data.length === 0) {
        if (at >= 0) entries.splice(at, 1);
      } else {
        const next: TreeEntry = { name, sha, type: "tree", mode: "40000" };
        if (at < 0) entries.push(next);
        else entries[at] = next;
      }
    } else if (content === null) {
      if (at >= 0) entries.splice(at, 1);
    } else {
      if (old?.type === "tree") fail(409, "Directory blocks file path");
      const o = await this.store.create("blob", bytes(content)),
        e: TreeEntry = {
          name,
          sha: o.oid,
          type: "blob",
          mode: old?.mode === "100755" ? "100755" : "100644",
        };
      if (at < 0) entries.push(e);
      else entries[at] = e;
    }
    return (await this.store.create("tree", treeBytes(entries))).oid;
  }
  async commit(b: {
    branch: string;
    expected_sha: string | null;
    message: string;
    files: { path: string; content: string | null }[];
    author: string;
    email: string;
  }) {
    this.branch(b.branch);
    const ref = "refs/heads/" + b.branch,
      parent = this.refs[ref] || null;
    if (b.expected_sha !== parent)
      fail(409, "Branch moved; refresh expected_sha");
    if (
      !b.message?.trim() ||
      b.message.length > 1000 ||
      !Array.isArray(b.files) ||
      !b.files.length ||
      b.files.length > 30
    )
      fail(400, "Invalid commit");
    let tree = parent
      ? parseCommit(await this.store.get(parent)).tree
      : undefined;
    const paths = new Set<string>();
    for (const file of b.files) {
      this.path(file.path);
      if (file.path.split("/").length > LIMITS.depth)
        fail(400, "Path too deep");
      if (paths.has(file.path)) fail(400, "Duplicate edit path");
      paths.add(file.path);
      if (
        file.content !== null &&
        (typeof file.content !== "string" ||
          bytes(file.content).length > 1024 * 1024)
      )
        fail(413, "File exceeds 1 MiB");
      tree = await this.editTree(tree, file.path.split("/"), file.content);
    }
    const name = (b.author || "ZQ-CfGit").replace(/[\n\r<>\0]/g, ""),
      email = (b.email || "noreply@zq-cfgit.local").replace(/[\n\r<>\0]/g, ""),
      identity = `${name} <${email}> ${Math.floor(Date.now() / 1000)} +0000`;
    const c = await this.store.create(
      "commit",
      bytes(
        `tree ${tree}\n${parent ? "parent " + parent + "\n" : ""}author ${identity}\ncommitter ${identity}\n\n${b.message}\n`,
      ),
    );
    await this.publish({ ...this.refs, [ref]: c.oid });
    return { sha: c.oid, branch: b.branch };
  }
  async updates(commands: { old: string; next: string; ref: string }[]) {
    const next = { ...this.refs },
      seen = new Set<string>();
    for (const command of commands) {
      if (
        !validRef(command.ref) ||
        !/^refs\/(heads|tags|notes)\//.test(command.ref) ||
        !isOid(command.old) ||
        !isOid(command.next) ||
        seen.has(command.ref)
      )
        fail(400, "Invalid or duplicate ref command");
      seen.add(command.ref);
      const old = this.refs[command.ref] || "0".repeat(40);
      if (old !== command.old) fail(409, "Reference changed concurrently");
      if (command.next === "0".repeat(40)) {
        if (command.ref === "refs/heads/" + this.defaultBranch)
          fail(409, "Cannot delete the default branch");
        delete next[command.ref];
        continue;
      }
      const o = await this.store.get(command.next);
      if (command.ref.startsWith("refs/heads/")) {
        if (o.type !== "commit") fail(400, "Branch must point to a commit");
        if (
          this.refs[command.ref] &&
          !this.policy.allowForce &&
          !(await this.store.ancestor(old, command.next))
        )
          fail(409, "Non-fast-forward push rejected");
      } else if (
        command.ref.startsWith("refs/tags/") &&
        this.refs[command.ref] &&
        old !== command.next &&
        !this.policy.allowForce
      )
        fail(409, "Existing tags cannot be rewritten");
      next[command.ref] = command.next;
    }
    checkRefs(next);
    await this.publish(next);
  }
  async validateFetch(wants: string[]) {
    const reachable = await this.store.walk(Object.values(this.refs));
    for (const want of wants)
      if (!reachable.has(want))
        fail(400, "Requested object is not reachable from repository refs");
    return reachable;
  }
}
