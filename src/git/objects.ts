import {
  objectEdges,
  type GitObjectIndex,
  type PersistedObjectHint,
} from "./object-index";
import { GitIO, gitStage } from "./diagnostics";
import type { ObjectCache } from "./object-cache";
import { fail } from "../security";
export const LIMITS = {
  object: 60 * 1024 * 1024,
  expanded: 64 * 1024 * 1024,
  pack: 64 * 1024 * 1024,
  objects: 20000,
  graph: 5000,
  transferGraph: 100000,
  fetchBytes: 512 * 1024 * 1024,
  cacheBytes: 8 * 1024 * 1024,
  refs: 256,
  depth: 64,
};
export type ObjectType = "commit" | "tree" | "blob" | "tag";
export interface GitObject {
  oid: string;
  type: ObjectType;
  data: Uint8Array;
}
export type Refs = Record<string, string>;
export const encoder = new TextEncoder(),
  decoder = new TextDecoder();
export const text = (data: Uint8Array) => decoder.decode(data);
export const bytes = (s: string) => encoder.encode(s);
export const ZERO = "0".repeat(40);
export const isOid = (s: string) => /^[0-9a-f]{40}$/.test(s);
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
export const toHex = (b: Uint8Array) =>
  Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
export function fromHex(s: string) {
  if (!/^(?:[0-9a-f]{2})+$/.test(s)) fail(400, "Invalid hexadecimal value");
  return Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));
}
export async function sha1(data: Uint8Array) {
  return toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-1", data as BufferSource)),
  );
}
/** 分段计算 Git 对象 ID，避免为了拼出完整缓冲再复制一份几十 MB 的数据。 */
export function sha1Parts(parts: Uint8Array[]): string {
  let h0 = 0x67452301,
    h1 = 0xefcdab89,
    h2 = 0x98badcfe,
    h3 = 0x10325476,
    h4 = 0xc3d2e1f0,
    total = 0,
    bufLen = 0;
  const buf = new Uint8Array(64),
    block = new Uint32Array(80);
  const run = (data: Uint8Array, off: number) => {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      block[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
    }
    for (let i = 16; i < 80; i++) {
      const w = block[i - 3] ^ block[i - 8] ^ block[i - 14] ^ block[i - 16];
      block[i] = ((w << 1) | (w >>> 31)) >>> 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = ((((a << 5) | (a >>> 27)) >>> 0) + (f >>> 0) + e + k + block[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  };
  for (const part of parts) {
    total += part.length;
    let i = 0;
    if (bufLen) {
      const take = Math.min(64 - bufLen, part.length);
      buf.set(part.subarray(0, take), bufLen);
      bufLen += take;
      i = take;
      if (bufLen === 64) {
        run(buf, 0);
        bufLen = 0;
      }
    }
    for (; i + 64 <= part.length; i += 64) run(part, i);
    if (i < part.length) {
      buf.set(part.subarray(i), 0);
      bufLen = part.length - i;
    }
  }
  const bits = total * 8,
    tail = new Uint8Array(bufLen < 56 ? 64 : 128);
  tail.set(buf.subarray(0, bufLen));
  tail[bufLen] = 0x80;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(tail.length - 4, bits >>> 0);
  for (let i = 0; i < tail.length; i += 64) run(tail, i);
  return [h0, h1, h2, h3, h4]
    .map((x) => x.toString(16).padStart(8, "0"))
    .join("");
}
export function canonical(object: Pick<GitObject, "type" | "data">) {
  return concat(bytes(`${object.type} ${object.data.length}\0`), object.data);
}
export async function makeObject(
  type: ObjectType,
  data: Uint8Array,
): Promise<GitObject> {
  if (data.length > LIMITS.object) fail(413, "Git object exceeds 60 MiB");
  return { oid: await sha1(canonical({ type, data })), type, data };
}
export async function readCanonical(
  data: Uint8Array,
  expected?: string,
): Promise<GitObject> {
  const nul = data.indexOf(0);
  if (nul < 0 || nul > 64) fail(400, "Invalid Git object header");
  const m = text(data.subarray(0, nul)).match(
    /^(commit|tree|blob|tag) (0|[1-9][0-9]*)$/,
  );
  if (!m || Number(m[2]) !== data.length - nul - 1)
    fail(400, "Git object size mismatch");
  const o = await makeObject(m[1] as ObjectType, data.subarray(nul + 1));
  if (expected && o.oid !== expected) fail(400, "Git object hash mismatch");
  return o;
}
export function validRef(ref: string) {
  return (
    /^refs\/(?:namespaces\/ephemeral\/refs\/)?(heads|tags|notes)\//.test(ref) &&
    bytes(ref).length <= 240 &&
    !/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("@{") &&
    ref
      .split("/")
      .every(
        (p) =>
          p && !p.startsWith(".") && !p.endsWith(".") && !p.endsWith(".lock"),
      )
  );
}
export function checkRefs(refs: Refs) {
  const names = Object.keys(refs).sort();
  if (names.length > LIMITS.refs) fail(413, "Maximum 256 refs");
  for (let i = 0; i < names.length; i++) {
    if (!validRef(names[i]) || !isOid(refs[names[i]])) fail(400, "Invalid ref");
    const parts = names[i].split("/");
    for (let j = 1; j < parts.length; j++)
      if (Object.hasOwn(refs, parts.slice(0, j).join("/")))
        fail(409, "Conflicting ref names");
  }
}
export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
  type: "tree" | "blob" | "commit";
}
export function parseTree(data: Uint8Array): TreeEntry[] {
  let pos = 0;
  const out: TreeEntry[] = [];
  const seen = new Set<string>();
  let previous: TreeEntry | undefined;
  while (pos < data.length) {
    const space = data.indexOf(32, pos),
      nul = data.indexOf(0, space + 1);
    if (space < pos || nul < space || nul + 21 > data.length)
      fail(400, "Malformed tree");
    const mode = text(data.subarray(pos, space));
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        data.subarray(space + 1, nul),
      );
    } catch {
      fail(400, "Only UTF-8 filenames are supported");
    }
    if (
      !["40000", "100644", "100755", "120000", "160000"].includes(mode) ||
      !name ||
      name.includes("/") ||
      name === "." ||
      name === ".." ||
      name.toLowerCase() === ".git" ||
      seen.has(name)
    )
      fail(400, "Unsafe or duplicate tree entry");
    seen.add(name);
    const entry: TreeEntry = {
      mode,
      name,
      sha: toHex(data.subarray(nul + 1, nul + 21)),
      type: mode === "40000" ? "tree" : mode === "160000" ? "commit" : "blob",
    };
    if (previous && compareEntries(previous, entry) >= 0)
      fail(400, "Unsorted tree entries");
    out.push(entry);
    previous = entry;
    pos = nul + 21;
  }
  return out;
}
function compareEntries(a: TreeEntry, b: TreeEntry) {
  const x = bytes(a.name + (a.type === "tree" ? "/" : "")),
    y = bytes(b.name + (b.type === "tree" ? "/" : ""));
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}
export function treeBytes(entries: TreeEntry[]) {
  const sorted = [...entries].sort(compareEntries);
  return concat(
    ...sorted.map((e) =>
      concat(bytes(`${e.mode} ${e.name}\0`), fromHex(e.sha)),
    ),
  );
}
export function parseCommit(o: GitObject) {
  if (o.type !== "commit") fail(400, "Expected commit");
  const split = text(o.data).indexOf("\n\n");
  if (split < 0) fail(400, "Malformed commit");
  const raw = text(o.data),
    lines = raw.slice(0, split).split("\n");
  const trees = lines.filter((l) => l.startsWith("tree ")),
    parents = lines
      .filter((l) => l.startsWith("parent "))
      .map((l) => l.slice(7));
  if (
    lines[0] !== trees[0] ||
    trees.length !== 1 ||
    !isOid(trees[0].slice(5)) ||
    parents.some((p) => !isOid(p)) ||
    parents.length > 64 ||
    lines.filter((l) => l.startsWith("author ")).length !== 1 ||
    lines.filter((l) => l.startsWith("committer ")).length !== 1
  )
    fail(400, "Invalid commit headers");
  return {
    tree: trees[0].slice(5),
    parents,
    author: lines.find((l) => l.startsWith("author "))!.slice(7),
    message: raw.slice(split + 2),
  };
}
export function parseTag(o: GitObject) {
  if (o.type !== "tag") fail(400, "Expected tag");
  const lines = text(o.data).split("\n\n")[0].split("\n"),
    oid = lines.find((l) => l.startsWith("object "))?.slice(7),
    type = lines.find((l) => l.startsWith("type "))?.slice(5);
  if (
    !oid ||
    !isOid(oid) ||
    lines[0] !== "object " + oid ||
    lines[1] !== "type " + type ||
    !lines[2]?.startsWith("tag ") ||
    lines[2].length === 4 ||
    !["commit", "tree", "blob", "tag"].includes(type || "")
  )
    fail(400, "Invalid annotated tag");
  return { oid, type: type as ObjectType };
}
export function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
/** Request-local object cache and staging area. No filesystem or native process. */
export class ObjectStore {
  readonly staged = new Map<string, GitObject>();
  private cache = new Map<string, GitObject>();
  private size = 0;
  private stagedSize = 0;
  private peakSize = 0;
  private r2Reads = 0;
  private r2Writes = 0;
  private readBytes = 0;
  private peakStaged = 0;
  private prefetchPeakBytes = 0;
  private prefetchPeakObjects = 0;
  private pending = new Map<string, Promise<GitObject>>();
  private indexHints = new Map<string, PersistedObjectHint>();
  private hintEdges = 0;
  constructor(
    readonly repoId: string,
    private bucket: Pick<R2Bucket, "get" | "put" | "delete">,
    private shared?: Pick<ObjectCache, "get" | "put">,
    readonly index?: GitObjectIndex,
    private io = new GitIO(undefined, (detail) =>
      console.warn("Git object I/O retry", { repoId, ...detail }),
    ),
  ) {
    if (index && index.repoId !== repoId)
      fail(409, "Git object index scope mismatch");
  }
  get ioUsage() {
    return {
      r2Reads: this.r2Reads,
      r2Writes: this.r2Writes,
      r2Retries: this.io.retries,
      readBytes: this.readBytes,
      peakStagedBytes: this.peakStaged,
      prefetchPeakBytes: this.prefetchPeakBytes,
      prefetchPeakObjects: this.prefetchPeakObjects,
      ...this.memoryUsage,
    };
  }
  get memoryUsage() {
    return {
      cachedBytes: this.size,
      peakCachedBytes: this.peakSize,
      stagedBytes: this.stagedSize,
    };
  }
  observePrefetch(bytes: number, objects: number) {
    this.prefetchPeakBytes = Math.max(this.prefetchPeakBytes, bytes);
    this.prefetchPeakObjects = Math.max(this.prefetchPeakObjects, objects);
  }
  private remember(o: GitObject) {
    const old = this.cache.get(o.oid);
    if (old && (old.type !== o.type || !sameBytes(old.data, o.data)))
      fail(409, "Conflicting content for Git object ID");
    if (old) {
      this.cache.delete(o.oid);
      this.size -= old.data.length;
    }
    while (
      this.cache.size &&
      (this.size + o.data.length > LIMITS.cacheBytes || this.cache.size >= 1024)
    ) {
      const key = this.cache.keys().next().value!;
      this.size -= this.cache.get(key)!.data.length;
      this.cache.delete(key);
    }
    this.cache.set(o.oid, o);
    this.size += o.data.length;
    this.peakSize = Math.max(this.peakSize, this.size);
    return o;
  }
  /**
   * 同步暂存清单一类的辅助数据：直接写 R2，不进对象索引，
   * 也不受 Durable Object 单值 128 KB 的限制。
   */
  async readAux(name: string): Promise<Uint8Array | undefined> {
    const stored = await this.io.run("object-read", async () => {
      this.r2Reads++;
      return this.bucket.get(`repos/${this.repoId}/aux/${name}`);
    });
    return stored ? new Uint8Array(await stored.arrayBuffer()) : undefined;
  }
  async writeAux(name: string, data: Uint8Array) {
    await this.io.run("object-write", async () => {
      this.r2Writes++;
      return this.bucket.put(`repos/${this.repoId}/aux/${name}`, data);
    });
  }
  async clearAux(name: string) {
    await this.io.run("object-write", () =>
      this.bucket.delete(`repos/${this.repoId}/aux/${name}`),
    );
  }
  async get(oid: string): Promise<GitObject> {
    if (!isOid(oid)) fail(400, "Invalid object ID");
    const existing = this.staged.get(oid) || this.cache.get(oid);
    if (existing) return this.remember(existing);
    const cached = this.shared?.get(this.repoId, oid);
    if (cached) return this.remember(cached);
    const inFlight = this.pending.get(oid);
    if (inFlight) return inFlight;
    const load = (async () => {
      const r = await this.io.run("object-read", async () => {
        this.r2Reads++;
        return this.bucket.get(`repos/${this.repoId}/objects/${oid}`);
      });
      if (!r) fail(409, "Missing Git object " + oid);
      if (r.size > LIMITS.object + 64) fail(413, "Stored object exceeds limit");
      this.readBytes += r.size;
      const object = await gitStage("object-verify", async () =>
        this.remember(
          await readCanonical(new Uint8Array(await r.arrayBuffer()), oid),
        ),
      );
      this.shared?.put(this.repoId, object);
      return object;
    })().finally(() => this.pending.delete(oid));
    this.pending.set(oid, load);
    return load;
  }
  add(o: GitObject) {
    const old = this.staged.get(o.oid);
    if (old && (old.type !== o.type || !sameBytes(old.data, o.data)))
      fail(409, "Conflicting staged Git object");
    if (!old) {
      if (this.stagedSize + o.data.length > LIMITS.expanded)
        fail(413, "Staged Git objects exceed 64 MiB");
      this.stagedSize += o.data.length;
      this.peakStaged = Math.max(this.peakStaged, this.stagedSize);
    }
    this.remember(o);
    this.staged.set(o.oid, o);
    return o;
  }
  async create(type: ObjectType, data: Uint8Array) {
    return this.add(await makeObject(type, data));
  }
  /** 记录由调用方直接写入 R2 的对象，后续索引校验无需回读内容。 */
  noteObject(oid: string, type: ObjectType, size: number) {
    if (!isOid(oid)) fail(400, "Invalid object ID");
    while (this.indexHints.size >= 4096) {
      const stale = this.indexHints.keys().next().value!;
      this.hintEdges -= this.indexHints.get(stale)!.edges.length;
      this.indexHints.delete(stale);
    }
    this.indexHints.set(oid, { type, size, edges: [] });
  }
  private rememberPersisted(o: GitObject) {
    if (!this.index || this.indexHints.has(o.oid) || this.index.get(o.oid))
      return;
    if (o.type !== "blob" && o.data.length > 2 * 1024 * 1024) return;
    let edges;
    try {
      edges = objectEdges(o);
    } catch {
      return;
    } // Preserve authoritative graph validation for malformed objects.
    if (edges.length > 16384) return;
    while (
      this.indexHints.size >= 4096 ||
      this.hintEdges + edges.length > 16384
    ) {
      const key = this.indexHints.keys().next().value!;
      this.hintEdges -= this.indexHints.get(key)!.edges.length;
      this.indexHints.delete(key);
    }
    this.indexHints.set(o.oid, { type: o.type, size: o.data.length, edges });
    this.hintEdges += edges.length;
  }
  async flush(concurrency = 2) {
    const objects = [...this.staged.values()];
    // Normal writes retain two lanes. Snapshot imports widen the lanes under an object-size budget.
    for (let i = 0; i < objects.length;) {
      const batch = objects.slice(i, i + concurrency);
      if (concurrency > 2)
        while (
          batch.length > 1 &&
          batch.reduce((sum, o) => sum + o.data.length, 0) > LIMITS.object
        )
          batch.pop();
      await settledPair(
        batch.map(async (o) => {
          const key = `repos/${this.repoId}/objects/${o.oid}`,
            data = canonical(o);
          if ((await sha1(data)) !== o.oid)
            fail(400, "Staged Git object hash mismatch");
          const result = await this.io.run("object-write", async () => {
            this.r2Writes++;
            return this.bucket.put(key, data, {
              onlyIf: { etagDoesNotMatch: "*" },
              httpMetadata: { contentType: "application/octet-stream" },
            });
          });
          if (result === null) {
            const existing = await this.io.run("object-read", async () => {
              this.r2Reads++;
              return this.bucket.get(key);
            });
            await gitStage("object-verify", async () => {
              if (
                !existing ||
                existing.size !== data.length ||
                !sameBytes(new Uint8Array(await existing.arrayBuffer()), data)
              )
                fail(409, "Conflicting stored Git object; refs unchanged");
            });
          }
          // Hash/conditional-content verification and successful persistence precede this metadata hint.
          this.rememberPersisted(o);
          this.shared?.put(this.repoId, o);
          this.staged.delete(o.oid);
          this.stagedSize -= o.data.length;
        }),
      );
      i += batch.length;
    }
  }
  /** Move in-memory hints into the durable index so later requests skip re-reading objects. */
  flushHints() {
    if (!this.index || !this.indexHints.size) return;
    this.index.recordMany(
      [...this.indexHints].map(([oid, hint]) => ({ oid, hint })),
    );
    this.indexHints.clear();
    this.hintEdges = 0;
  }
  async validateClosure(roots: string[]) {
    if (!this.index) {
      await this.walk(roots);
      return;
    }
    if (this.staged.size)
      fail(409, "Persist staged Git objects before indexing");
    await gitStage("object-index", () =>
      this.index!.ensure(
        roots,
        (oid) => this.get(oid),
        (oid) => this.indexHints.get(oid),
      ),
    );
  }
  async walk(roots: string[], exclude = new Set<string>()) {
    if (this.index && !this.staged.size) {
      await this.validateClosure(roots);
      return gitStage("object-index", async () =>
        this.index!.walk(roots, exclude),
      );
    }
    const seen = new Set<string>(),
      todo = roots.map((oid) => ({
        oid,
        type: undefined as ObjectType | undefined,
      }));
    while (todo.length) {
      const batch = todo.splice(-2).filter(({ oid }) => !exclude.has(oid));
      const objects = await settledPair(batch.map(({ oid }) => this.get(oid)));
      for (let i = 0; i < batch.length; i++) {
        const { oid, type } = batch[i],
          o = objects[i];
        // Every edge is checked, even when another path already visited this object.
        if (type && o.type !== type)
          fail(400, "Git object graph type mismatch");
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (seen.size > LIMITS.graph)
          fail(413, "Object graph exceeds 5000 objects");
        if (o.type === "commit") {
          const c = parseCommit(o);
          todo.push(
            { oid: c.tree, type: "tree" },
            ...c.parents.map((oid) => ({ oid, type: "commit" as const })),
          );
        } else if (o.type === "tree") {
          for (const e of parseTree(o.data))
            if (e.mode !== "160000")
              todo.push({ oid: e.sha, type: e.type as ObjectType });
        } else if (o.type === "tag") todo.push(parseTag(o));
      }
    }
    return seen;
  }
  async ancestor(base: string, tip: string) {
    const seen = new Set<string>(),
      todo = [tip];
    while (todo.length) {
      const id = todo.pop()!;
      if (id === base) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      if (seen.size > LIMITS.graph) fail(413, "Commit graph too large");
      todo.push(...parseCommit(await this.get(id)).parents);
    }
    return false;
  }
  async resolve(ref: string, refs: Refs, defaultBranch: string) {
    const value =
      ref === "HEAD"
        ? refs[`refs/heads/${defaultBranch}`]
        : refs[ref] ||
          refs["refs/heads/" + ref] ||
          refs["refs/tags/" + ref] ||
          (isOid(ref) ? ref : undefined);
    if (!value) fail(409, "Revision not found");
    let oid = value;
    for (let i = 0; i < LIMITS.depth; i++) {
      const o = await this.get(oid);
      if (o.type === "commit") return oid;
      if (o.type !== "tag") fail(409, "Revision does not name a commit");
      oid = parseTag(o).oid;
    }
    fail(400, "Tag chain too deep");
  }
}

/** Drain in-flight I/O before rejecting, so callers cannot publish or retry while it mutates caches. */
async function settledPair<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}
