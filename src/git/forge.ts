import { literalPatch } from "./binary-patch";
import { diffArrays, diffLines, createTwoFilesPatch } from "diff";
import { GitRepository } from "./repository";
import {
  TreeEntry,
  bytes,
  text,
  parseCommit,
  parseTag,
  treeBytes,
  ZERO,
  LIMITS,
} from "./objects";
import { fail } from "../security";
import { unbase64 } from "./signatures";
import {
  paginate,
  PageOptions,
  identity,
  parseIdentity,
  pathFilter,
  tarEntries,
  streamFrom,
} from "./forge-utils";
export interface SignatureIdentity {
  name: string;
  email: string;
  timestamp?: number;
}
const BLAME_LIMITS = {
  commits: 120,
  lines: 4000,
  bytes: 512 * 1024,
};
export class ForgeRepository extends GitRepository {
  peer?: (ephemeral: boolean) => ForgeRepository;
  async revision(ref = "HEAD"): Promise<string> {
    if (/^[0-9a-f]{4,39}$/.test(ref)) {
      const matches = [
        ...(await this.store.walk(Object.values(this.refs))),
      ].filter((id) => id.startsWith(ref));
      if (matches.length !== 1)
        fail(409, "Short object ID is missing or ambiguous");
      ref = matches[0];
    }
    const match = ref.match(/^(.*?)([~^])(\d*)$/);
    if (match) {
      let id = await this.revision(match[1]);
      const n = Number(match[3] || 1);
      if (!Number.isSafeInteger(n) || n > LIMITS.graph)
        fail(400, "Invalid ancestry selector");
      if (match[2] === "^") {
        if (n === 0) return id;
        const c = parseCommit(await this.store.get(id));
        if (!c.parents[n - 1]) fail(409, "Parent not found");
        return c.parents[n - 1];
      }
      for (let i = 0; i < n; i++) {
        const c = parseCommit(await this.store.get(id));
        if (!c.parents[0]) fail(409, "Ancestor not found");
        id = c.parents[0];
      }
      return id;
    }
    return this.resolve(ref);
  }
  async resolve(ref = "HEAD"): Promise<string> {
    if (/^[0-9a-f]{4,39}$/.test(ref) || /[~^]\d*$/.test(ref))
      return this.revision(ref);
    return super.resolve(ref);
  }
  async metadata(ref: string) {
    const sha = await this.revision(ref),
      o = await this.store.get(sha),
      c = parseCommit(o),
      raw = text(o.data),
      headers = raw.slice(0, raw.indexOf("\n\n")).split("\n"),
      a = parseIdentity(c.author),
      committer = parseIdentity(
        headers.find((l) => l.startsWith("committer "))!.slice(10),
      );
    return {
      sha,
      tree_sha: c.tree,
      parent_shas: c.parents,
      message: c.message,
      author: a.name,
      author_name: a.name,
      author_email: a.email,
      committer_name: committer.name,
      committer_email: committer.email,
      date: committer.date,
      raw_date: committer.date,
    };
  }
  async commitHistory(ref = "HEAD", path?: string) {
    const root = await this.revision(ref),
      seen = new Set<string>(),
      todo = [root],
      all = [];
    while (todo.length) {
      const id = todo.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > LIMITS.graph) fail(413, "History traversal too large");
      const c = parseCommit(await this.store.get(id));
      todo.push(...c.parents);
      let include = true;
      if (path) {
        this.path(path);
        const current = await this.maybeEntry(id, path);
        include = !c.parents.length
          ? !!current
          : !(
              await Promise.all(c.parents.map((p) => this.maybeEntry(p, path)))
            ).some(
              (previous) =>
                previous?.sha === current?.sha &&
                previous?.mode === current?.mode,
            );
      }
      if (include) all.push(await this.metadata(id));
    }
    all.sort(
      (a, b) => b.date.localeCompare(a.date) || a.sha.localeCompare(b.sha),
    );
    return { root, all };
  }
  async maybeEntry(ref: string, path: string) {
    try {
      return (await this.entry(ref, path)).entry;
    } catch (e) {
      if ((e as any).status === 404) return undefined;
      throw e;
    }
  }
  async listCommits(options: PageOptions & { ref?: string; path?: string }) {
    const { root, all } = await this.commitHistory(
        options.ref || "HEAD",
        options.path,
      ),
      p = paginate(
        all,
        options,
        root + ":commits:" + JSON.stringify(options.path || ""),
      );
    return {
      commits: p.items,
      next_cursor: p.next_cursor,
      has_more: p.has_more,
      ref: root,
    };
  }
  listBranches(options: PageOptions = {}) {
    const branches = Object.entries(this.refs)
        .filter(([r]) => r.startsWith("refs/heads/"))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([ref, sha]) => ({ name: ref.slice(11), sha })),
      p = paginate(branches, options, JSON.stringify(branches));
    return {
      branches: p.items,
      next_cursor: p.next_cursor,
      has_more: p.has_more,
    };
  }
  async createBranch(b: {
    target_branch: string;
    base_ref?: string;
    base_branch?: string;
    base_is_ephemeral?: boolean;
    expected_target_sha?: string | null;
  }) {
    const name = this.branch(b.target_branch),
      ref = "refs/heads/" + name,
      old = this.refs[ref];
    if (old) fail(409, "Branch already exists");
    if (b.expected_target_sha) fail(409, "Branch does not exist");
    const source = this.peer?.(!!b.base_is_ephemeral) || this,
      sha = await source.revision(b.base_ref || b.base_branch || "HEAD");
    await this.updates([{ ref, old: ZERO, next: sha }]);
    return { target_branch: name, sha };
  }
  async deleteBranch(name: string, expected?: string) {
    this.branch(name);
    const ref = "refs/heads/" + name,
      old = this.refs[ref];
    if (!old) fail(404, "Branch not found");
    if (expected && expected !== old) fail(409, "Branch moved");
    await this.updates([{ ref, old, next: ZERO }]);
    return { deleted: true, name };
  }
  async listTags(options: PageOptions = {}) {
    const tags = [];
    for (const [ref, oid] of Object.entries(this.refs)
      .filter(([r]) => r.startsWith("refs/tags/"))
      .sort(([a], [b]) => a.localeCompare(b))) {
      let target = await this.store.get(oid),
        depth = 0;
      while (target.type === "tag") {
        if (++depth > LIMITS.depth) fail(413, "Tag chain too deep");
        target = await this.store.get(parseTag(target).oid);
      }
      tags.push({
        name: ref.slice(10),
        sha: target.oid,
        object_sha: oid,
        type: target.type,
      });
    }
    const p = paginate(tags, options, JSON.stringify(tags));
    return { tags: p.items, next_cursor: p.next_cursor, has_more: p.has_more };
  }
  async createTag(name: string, ref = "HEAD") {
    const target = "refs/tags/" + name;
    if (this.refs[target]) fail(409, "Tag already exists");
    const sha = await this.revision(ref);
    await this.updates([{ ref: target, old: ZERO, next: sha }]);
    return { name, sha };
  }
  async deleteTag(name: string) {
    const ref = "refs/tags/" + name,
      old = this.refs[ref];
    if (!old) fail(404, "Tag not found");
    await this.updates([{ ref, old, next: ZERO }]);
    return { deleted: true, name };
  }
  async buildTree(files: Map<string, TreeEntry>) {
    type Directory = Map<string, TreeEntry | Directory>;
    const root: Directory = new Map();
    for (const [path, e] of files) {
      this.path(path);
      let dir = root;
      const parts = path.split("/");
      if (parts.length > LIMITS.depth) fail(413, "Directory nesting too deep");
      for (const part of parts.slice(0, -1)) {
        const found = dir.get(part);
        if (found && !(found instanceof Map))
          fail(409, "File/directory conflict");
        if (!found) dir.set(part, new Map());
        dir = dir.get(part) as Directory;
      }
      const last = parts.at(-1)!;
      if (dir.get(last) instanceof Map) fail(409, "File/directory conflict");
      dir.set(last, { ...e, name: last });
    }
    const build = async (dir: Directory): Promise<string> => {
      const entries: TreeEntry[] = [];
      for (const [name, item] of dir)
        entries.push(
          item instanceof Map
            ? { name, sha: await build(item), type: "tree", mode: "40000" }
            : item,
        );
      return (await this.store.create("tree", treeBytes(entries))).oid;
    };
    return build(root);
  }
  async writeCommit(
    tree: string,
    parents: string[],
    b: {
      commit_message: string;
      author: SignatureIdentity;
      committer?: SignatureIdentity;
    },
  ) {
    if (
      typeof b.commit_message !== "string" ||
      !b.commit_message.trim() ||
      b.commit_message.length > 10000 ||
      b.commit_message.includes("\0")
    )
      fail(400, "Invalid commit message");
    const author = identity(b.author),
      committer = identity(b.committer || b.author);
    return this.store.create(
      "commit",
      bytes(
        `tree ${tree}\n${parents.map((p) => "parent " + p + "\n").join("")}author ${author}\ncommitter ${committer}\n\n${b.commit_message}${b.commit_message.endsWith("\n") ? "" : "\n"}`,
      ),
    );
  }
  /** 暂存清单存 R2 而不是 DO storage：文件多的仓库会超过 storage 单值 128 KB 上限。 */
  private async readStaging(key: string) {
    const raw = await this.store.readAux(key);
    if (!raw) return [] as { path: string; sha: string; mode: string }[];
    try {
      const parsed = JSON.parse(text(raw));
      return Array.isArray(parsed)
        ? (parsed as { path: string; sha: string; mode: string }[])
        : [];
    } catch {
      fail(409, "Snapshot staging list is corrupted; retry the sync");
    }
  }
  private async writeStaging(key: string, entries: unknown[]) {
    await this.store.writeAux(key, bytes(JSON.stringify(entries)));
  }
  /**
   * Snapshot import. Batches stage blobs and flush them to storage; the final call
   * builds the tree and publishes. Only one batch of file bodies is resident at a time.
   */
  async replaceSnapshot(b: {
    target_branch: string;
    commit_message: string;
    author: SignatureIdentity;
    committer?: SignatureIdentity;
    files: { path: string; data: string | Uint8Array; mode?: string }[];
    append?: boolean;
    final?: boolean;
    /** 单次同步的暂存命名空间，避免上一轮中断留下的列表污染新一轮。 */
    token?: string;
  }) {
    this.branch(b.target_branch);
    const ref = "refs/heads/" + b.target_branch,
      old = this.refs[ref] || null;
    if (!Array.isArray(b.files)) fail(400, "Invalid file list");
    const incremental = b.append === true;
    if (!incremental && !b.files.length && b.final !== false)
      fail(400, "Sync requires at least one file");
    const pendingKey = "import/" + (b.token || "pending") + ".json";
    const staged: { path: string; sha: string; mode: string }[] = incremental
      ? await this.readStaging(pendingKey)
      : [];
    const seen = new Set(staged.map((e) => e.path));
    for (const f of b.files) {
      this.path(f.path);
      if (seen.has(f.path)) fail(400, "Duplicate path: " + f.path);
      seen.add(f.path);
    }
    for (let i = 0; i < b.files.length; i += 8) {
      const slice = b.files.slice(i, i + 8),
        objects = await Promise.all(
          slice.map((f) =>
            this.store.create(
              "blob",
              typeof f.data === "string" ? unbase64(f.data) : f.data,
            ),
          ),
        );
      objects.forEach((o, j) => {
        const f = slice[j];
        staged.push({
          path: f.path,
          sha: o.oid,
          mode:
            f.mode && ["100644", "100755", "120000"].includes(f.mode)
              ? f.mode
              : "100644",
        });
      });
    }
    await this.store.flush(16);
    this.store.flushHints();
    if (b.final === false) {
      await this.writeStaging(pendingKey, staged);
      return {
        staged: staged.length,
        blob_count: 0,
        target_branch: b.target_branch,
      };
    }
    const entries = new Map<string, TreeEntry>();
    for (const e of staged)
      entries.set(e.path, {
        name: e.path.split("/").at(-1)!,
        mode: e.mode,
        type: "blob",
        sha: e.sha,
      });
    const tree = await this.buildTree(entries),
      commit = await this.writeCommit(tree, old ? [old] : [], b);
    await this.publish({ ...this.refs, [ref]: commit.oid });
    await this.store.clearAux(pendingKey);
    return {
      sha: commit.oid,
      tree_sha: tree,
      blob_count: entries.size,
      target_branch: b.target_branch,
    };
  }
  /** 大文件由调用方直接写入 R2，这里只登记暂存条目与索引提示。 */
  async stageBlobRef(b: {
    path: string;
    mode: string;
    oid: string;
    size: number;
    token?: string;
  }) {
    this.path(b.path);
    const pendingKey = "import/" + (b.token || "pending") + ".json";
    const staged = await this.readStaging(pendingKey);
    if (staged.some((e) => e.path === b.path))
      fail(400, "Duplicate path: " + b.path);
    staged.push({
      path: b.path,
      sha: b.oid,
      mode: ["100644", "100755", "120000"].includes(b.mode) ? b.mode : "100644",
    });
    await this.writeStaging(pendingKey, staged);
    this.store.noteObject(b.oid, "blob", b.size);
    this.store.flushHints();
    return { staged: staged.length, oid: b.oid };
  }
  async rawFile(request: Request, ref: string, path: string) {
    const { oid, entry } = await this.entry(ref, this.path(path));
    if (entry.type !== "blob") fail(400, "Path is not a file");
    const o = await this.store.get(entry.sha),
      meta =
        (await this.commitHistory(oid, path)).all[0] ||
        (await this.metadata(oid)),
      etag = '"' + o.oid + '"',
      modified = new Date(meta.date).toUTCString(),
      headers = new Headers({
        "content-type": "application/octet-stream",
        etag: etag,
        "last-modified": modified,
        "accept-ranges": "bytes",
        "x-git-commit": oid,
        "x-git-object": o.oid,
        "cache-control": "private, max-age=0, must-revalidate",
      });
    const matches = (value: string | null, weak = false) =>
      value?.split(",").some((v) => {
        v = v.trim();
        if (weak) v = v.replace(/^W\//, "");
        return v === "*" || v === etag;
      });
    if (
      request.headers.has("if-match") &&
      !matches(request.headers.get("if-match"))
    )
      return new Response(null, { status: 412, headers });
    if (
      !request.headers.has("if-match") &&
      request.headers.has("if-unmodified-since") &&
      Date.parse(modified) >
        Date.parse(request.headers.get("if-unmodified-since")!)
    )
      return new Response(null, { status: 412, headers });
    if (
      matches(request.headers.get("if-none-match"), true) ||
      (!request.headers.has("if-none-match") &&
        request.headers.has("if-modified-since") &&
        Date.parse(modified) <=
          Date.parse(request.headers.get("if-modified-since")!))
    )
      return new Response(null, { status: 304, headers });
    let start = 0,
      end = o.data.length - 1,
      status = 200;
    const range = request.headers.get("range"),
      ifRange = request.headers.get("if-range");
    if (
      range &&
      (!ifRange ||
        ifRange === etag ||
        Date.parse(ifRange) >= Date.parse(modified))
    ) {
      const m = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!m || (!m[1] && !m[2]) || !o.data.length) {
        headers.set("content-range", "bytes */" + o.data.length);
        return new Response(null, { status: 416, headers });
      }
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), end) : end;
      } else {
        const n = Number(m[2]);
        if (n === 0) start = o.data.length;
        else start = Math.max(0, o.data.length - n);
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= o.data.length
      ) {
        headers.set("content-range", "bytes */" + o.data.length);
        return new Response(null, { status: 416, headers });
      }
      status = 206;
      headers.set("content-range", `bytes ${start}-${end}/${o.data.length}`);
    }
    headers.set("content-length", String(Math.max(0, end - start + 1)));
    return new Response(
      request.method === "HEAD"
        ? null
        : (o.data.subarray(start, end + 1) as BodyInit),
      { status, headers },
    );
  }
  async archive(options: {
    ref: string;
    archive?: { prefix?: string };
    include_globs?: string[];
    exclude_globs?: string[];
    max_blob_size?: number;
  }) {
    const { oid, files } = await this.files(options.ref || "HEAD"),
      meta = await this.metadata(oid),
      self = this;
    const selected = [...files].filter(
      ([path, e]) => e.type === "blob" && pathFilter(path, options),
    );
    const entries = async function* () {
      for (const [path, e] of selected) {
        const data = (await self.store.get(e.sha)).data;
        if (
          options.max_blob_size !== undefined &&
          data.length > options.max_blob_size
        )
          continue;
        yield { path, data, mode: e.mode };
      }
    };
    const prefix = options.archive?.prefix || "";
    if (
      prefix &&
      (prefix.startsWith("/") ||
        prefix.split("/").some((p) => p === ".." || p === ".") ||
        /[\0\r\n]/.test(prefix))
    )
      fail(400, "Invalid archive prefix");
    const stream = (
      streamFrom(
        tarEntries(entries(), prefix, Math.floor(Date.parse(meta.date) / 1000)),
      ) as ReadableStream<BufferSource>
    ).pipeThrough(new CompressionStream("gzip"));
    return new Response(stream, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${oid}.tar.gz"`,
        "x-git-commit": oid,
      },
    });
  }
  async diff(
    source: string,
    target?: string,
    options: { paths?: string[]; context?: number } = {},
  ) {
    const src = await this.revision(source),
      commit = parseCommit(await this.store.get(src)),
      base = target ? await this.revision(target) : commit.parents[0],
      a = base ? (await this.files(base)).files : new Map<string, TreeEntry>(),
      b = (await this.files(src)).files;
    const result: any[] = [];
    let patch = "",
      added = 0,
      removed = 0;
    const context = options.context ?? 3;
    if (!Number.isInteger(context) || context < 0 || context > 100)
      fail(400, "Invalid diff context");
    const changed = [...new Set([...a.keys(), ...b.keys()])]
      .sort()
      .filter((path) => pathFilter(path, { paths: options.paths }))
      .filter((path) => {
        const old = a.get(path),
          next = b.get(path);
        return !(old?.sha === next?.sha && old?.mode === next?.mode);
      });
    // 一次性导入（无父提交）或超大变更会读全部对象、逐文件生成补丁，
    // 把子请求与 CPU 预算耗尽、请求挂死。超过预算时只列文件清单，秒回。
    if (changed.length > 200) {
      for (const path of changed) {
        const old = a.get(path),
          next = b.get(path);
        result.push({
          path,
          status: !old ? "added" : !next ? "deleted" : "modified",
          old_sha: old?.sha || null,
          new_sha: next?.sha || null,
          old_mode: old?.mode || null,
          new_mode: next?.mode || null,
          binary: false,
          patch: "",
        });
      }
      return {
        source_sha: src,
        target_sha: base || null,
        diff: "",
        patch: "",
        files: result,
        truncated: true,
        stats: { files: result.length, additions: 0, deletions: 0 },
      };
    }
    for (const path of changed) {
      const old = a.get(path),
        next = b.get(path);
      const left =
          old?.type === "blob"
            ? (await this.store.get(old.sha)).data
            : bytes(old ? `Subproject commit ${old.sha}\n` : ""),
        right =
          next?.type === "blob"
            ? (await this.store.get(next.sha)).data
            : bytes(next ? `Subproject commit ${next.sha}\n` : ""),
        binary = left.includes(0) || right.includes(0);
      let value = `diff --git ${JSON.stringify("a/" + path)} ${JSON.stringify("b/" + path)}\n`;
      if (!old) value += "new file mode " + next!.mode + "\n";
      else if (!next) value += "deleted file mode " + old.mode + "\n";
      else if (old.mode !== next.mode)
        value += `old mode ${old.mode}\nnew mode ${next.mode}\n`;
      value += `index ${old?.sha || ZERO}..${next?.sha || ZERO}\n`;
      if (binary)
        value +=
          "GIT binary patch\n" + literalPatch(right) + literalPatch(left);
      else {
        const hunks = createTwoFilesPatch(
          old ? "a/" + path : "/dev/null",
          next ? "b/" + path : "/dev/null",
          text(left),
          text(right),
          "",
          "",
          { context, timeout: 500, maxEditLength: 20000 },
        );
        if (!hunks) fail(413, "Diff computation budget exceeded");
        value += hunks.replace(/^=+\n/, "");
        for (const part of diffLines(text(left), text(right), {
          timeout: 500,
          maxEditLength: 20000,
        }) || [])
          if (part.added) added += part.count || 0;
          else if (part.removed) removed += part.count || 0;
      }
      patch += value;
      if (bytes(patch).length > 4 * 1024 * 1024)
        fail(413, "Diff exceeds 4 MiB");
      result.push({
        path,
        status: !old ? "added" : !next ? "deleted" : "modified",
        old_sha: old?.sha || null,
        new_sha: next?.sha || null,
        old_mode: old?.mode || null,
        new_mode: next?.mode || null,
        binary,
        patch: value,
      });
    }
    return {
      source_sha: src,
      target_sha: base || null,
      diff: patch,
      patch,
      files: result,
      stats: { files: result.length, additions: added, deletions: removed },
    };
  }
  /** 逐行归属：按文件历史从旧到新重放，未改动的行沿用上一版所属的提交。 */
  async blame(ref: string, path: string) {
    const head = await this.revision(ref);
    this.path(path);
    const blobAt = new Map<string, string | null>(),
      blobOf = async (sha: string) => {
        const known = blobAt.get(sha);
        if (known !== undefined) return known;
        const entry = await this.maybeEntry(sha, path),
          value = entry?.type === "blob" ? entry.sha : null;
        blobAt.set(sha, value);
        return value;
      };
    const touching: {
        sha: string;
        blob: string;
        date: string;
        author: string;
        message: string;
      }[] = [],
      seen = new Set<string>(),
      pending = [head];
    let truncated = false;
    while (pending.length) {
      if (seen.size >= BLAME_LIMITS.commits) {
        truncated = true;
        break;
      }
      const id = pending.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const commit = parseCommit(await this.store.get(id)),
        own = await blobOf(id);
      pending.push(...commit.parents);
      if (!own) continue;
      let carried = false;
      for (const parent of commit.parents)
        if ((await blobOf(parent)) === own) {
          carried = true;
          break;
        }
      if (carried) continue;
      const who = parseIdentity(commit.author);
      touching.push({
        sha: id,
        blob: own,
        date: who.date,
        author: who.name,
        message: commit.message.split("\n")[0],
      });
    }
    if (!touching.length) fail(404, "File not found");
    touching.sort(
      (a, b) => a.date.localeCompare(b.date) || a.sha.localeCompare(b.sha),
    );
    let lines: string[] = [],
      marks: string[] = [];
    for (let i = 0; i < touching.length; i++) {
      const data = (await this.store.get(touching[i].blob)).data;
      if (data.includes(0))
        return { ref: head, path, binary: true, lines: [], commits: {} };
      if (data.length > BLAME_LIMITS.bytes) fail(413, "File too large to blame");
      const next = data.length ? text(data).replace(/\n$/, "").split("\n") : [];
      if (next.length > BLAME_LIMITS.lines)
        fail(413, "File too large to blame");
      if (!i) {
        lines = next;
        marks = next.map(() => touching[0].sha);
        continue;
      }
      const nextMarks: string[] = [];
      let at = 0,
        index = 0;
      for (const part of diffArrays(lines, next)) {
        if (part.added)
          for (let k = 0; k < part.value.length; k++)
            nextMarks[index++] = touching[i].sha;
        else if (part.removed) at += part.value.length;
        else
          for (let k = 0; k < part.value.length; k++)
            nextMarks[index++] = marks[at++];
      }
      lines = next;
      marks = nextMarks;
    }
    const commits: Record<
      string,
      { author: string; date: string; message: string }
    > = {};
    for (const entry of touching)
      commits[entry.sha] = {
        author: entry.author,
        date: entry.date,
        message: entry.message,
      };
    return {
      ref: head,
      path,
      binary: false,
      truncated,
      lines: lines.map((value, i) => ({
        n: i + 1,
        sha: marks[i] || touching[touching.length - 1].sha,
        text: value,
      })),
      commits,
    };
  }
}
