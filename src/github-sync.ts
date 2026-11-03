import { HTTPException } from "hono/http-exception";
import { fail } from "./security";

/** 单文件与仓库总量上限，均为解压后的原始字节。 */
const MAX_FILE = 24 * 1024 * 1024;
const MAX_TOTAL = 30 * 1024 * 1024;
const MAX_FILES = 3000;
/** 每个批次的原始字节与文件数上限，避免单个请求内的存储调用超过运行时配额。 */
const BATCH_BYTES = 6 * 1024 * 1024;
const BATCH_FILES = 300;

export interface SyncFile {
  path: string;
  data: string;
  mode: string;
}

export interface GithubSnapshotInfo {
  owner: string;
  name: string;
  branch: string;
  files: number;
}

export type SyncBatchSink = (files: SyncFile[]) => Promise<void>;

function cstr(data: Uint8Array): string {
  const end = data.indexOf(0);
  return new TextDecoder().decode(end < 0 ? data : data.subarray(0, end));
}

function bytesToBase64(data: Uint8Array): string {
  // Encode in 3-byte-aligned slices so no full-size binary string is ever built.
  const SLICE = 0x4000 * 3;
  let out = "";
  for (let i = 0; i < data.length; i += SLICE) {
    const slice = data.subarray(i, i + SLICE);
    let bin = "";
    for (let j = 0; j < slice.length; j += 0x4000)
      bin += String.fromCharCode(...slice.subarray(j, j + 0x4000));
    out += btoa(bin);
  }
  return out;
}

function join(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  if (parts.length === 1) return parts[0] as Uint8Array<ArrayBuffer>;
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function parseSource(source: string): { owner: string; name: string } {
  let s = source.trim();
  s = s
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2)
    fail(400, "请输入 owner/name 格式的 GitHub 仓库，例如 bayueqi/my-repo");
  const owner = parts[0],
    name = parts[1];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-_.]*$/.test(owner) || !/^[a-zA-Z0-9._-]+$/.test(name))
    fail(400, "无效的 GitHub 仓库名");
  return { owner, name };
}

async function defaultBranch(owner: string, name: string): Promise<string> {
  try {
    const meta = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
      headers: {
        "user-agent": "zq-cfgit-sync",
        accept: "application/vnd.github+json",
      },
    });
    if (meta.ok) {
      const info = (await meta.json()) as { default_branch?: string };
      if (info.default_branch) return info.default_branch;
    }
  } catch {
    /* 查询默认分支失败则回退 main */
  }
  return "main";
}

type Pending = {
  kind: "file" | "pax" | "skip";
  path: string;
  mode: number;
  /** 含 512 对齐填充的总字节数 */
  remaining: number;
  /** 有效内容字节数 */
  content: number;
  got: number;
  parts: Uint8Array[];
};

const strip = (n: string) => {
  const i = n.indexOf("/");
  return i < 0 ? n : n.slice(i + 1);
};

/**
 * 流式解析归档：解压、拆包、分批交出去，任何时刻只保留一个批次和当前文件。
 * 返回文件总数。
 */
async function readTar(resp: Response, sink: SyncBatchSink): Promise<number> {
  if (!resp.body) fail(503, "GitHub 未返回归档内容");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = resp.body
      .pipeThrough(new DecompressionStream("gzip"))
      .getReader();
  } catch {
    fail(503, "解压 GitHub 归档失败");
  }
  let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let batch: SyncFile[] = [];
  let batchBytes = 0;
  let total = 0,
    count = 0;
  let paxPath: string | undefined;
  let pending: Pending | null = null;

  const flushBatch = async () => {
    if (!batch.length) return;
    const out = batch;
    batch = [];
    batchBytes = 0;
    await sink(out);
  };

  const pushFile = async (path: string, mode: number, data: Uint8Array) => {
    total += data.length;
    if (total > MAX_TOTAL)
      fail(413, `仓库解压后超过 ${MAX_TOTAL / 1048576} MB，请改用 git push 同步`);
    count++;
    if (count > MAX_FILES) fail(413, "文件数量过多，无法一次性同步");
    // 大文件不与现有批次合并，保证单次请求的体积不超过一个批次预算。
    if (batch.length && batchBytes + data.length > BATCH_BYTES) await flushBatch();
    batch.push({
      path,
      data: bytesToBase64(data),
      mode: mode & 0o111 ? "100755" : "100644",
    });
    batchBytes += data.length;
    if (batchBytes >= BATCH_BYTES || batch.length >= BATCH_FILES)
      await flushBatch();
  };

  const drain = async () => {
    for (;;) {
      if (pending) {
        if (pending.remaining > 0) {
          if (!buf.length) return;
          const take = Math.min(pending.remaining, buf.length),
            contentTake = Math.min(take, pending.content - pending.got);
          if (contentTake > 0) {
            pending.parts.push(buf.subarray(0, contentTake));
            pending.got += contentTake;
          }
          buf = buf.subarray(take);
          pending.remaining -= take;
          continue;
        }
        const job = pending;
        pending = null;
        if (job.kind === "pax") {
          for (const line of new TextDecoder()
            .decode(join(job.parts))
            .split("\n")) {
            const m = line.match(/^\d+ path=(.*)$/);
            if (m) paxPath = m[1];
          }
          continue;
        }
        if (job.kind === "skip") {
          paxPath = undefined;
          continue;
        }
        let full = job.path;
        if (paxPath) {
          full = paxPath;
          paxPath = undefined;
        }
        full = strip(full);
        if (!full) continue;
        if (
          full.split("/").includes("..") ||
          full.startsWith("/") ||
          full.includes("\0") ||
          full.includes("\r")
        )
          fail(400, "归档路径不安全");
        const content = join(job.parts);
        job.parts.length = 0;
        await pushFile(full, job.mode, content);
        continue;
      }
      if (buf.length < 512) return;
      const header = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (header.every((b) => b === 0)) return;
      const hname = cstr(header.subarray(0, 100));
      const mode = parseInt(cstr(header.subarray(100, 108)).trim() || "0", 8);
      const size = parseInt(cstr(header.subarray(124, 136)).trim() || "0", 8);
      const type = header[156];
      const prefix = cstr(header.subarray(345, 500));
      const full = prefix ? prefix + "/" + hname : hname;
      if (!Number.isSafeInteger(size) || size < 0) fail(400, "归档数据损坏");
      if (size > MAX_FILE)
        fail(
          413,
          `文件过大：${full}（${(size / 1048576).toFixed(1)} MB，上限 ${MAX_FILE / 1048576} MB）`,
        );
      pending = {
        kind:
          type === 120 || type === 103
            ? "pax"
            : type === 0 || type === 48
              ? "file"
              : "skip",
        path: full,
        mode,
        remaining: Math.ceil(size / 512) * 512,
        content: size,
        got: 0,
        parts: [],
      };
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value?.length) {
        buf = buf.length ? join([buf, value]) : value;
      }
      await drain();      if (done) break;
    }
    await flushBatch();
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    fail(503, "解压 GitHub 归档失败");
  }
  return count;
}

/** 下载并流式解析 GitHub 仓库快照，每累计一个批次调用一次 sink。 */
export async function streamGithubSnapshot(
  source: string,
  sink: SyncBatchSink,
): Promise<GithubSnapshotInfo> {
  const { owner, name } = parseSource(source);
  const wanted = await defaultBranch(owner, name);
  const candidates = [wanted, "main", "master"].filter(
    (b, i, a) => a.indexOf(b) === i,
  );
  let resp: Response | null = null,
    used = wanted;
  for (const b of candidates) {
    const r = await fetch(
      `https://codeload.github.com/${owner}/${name}/tar.gz/refs/heads/${b}`,
      { headers: { "user-agent": "zq-cfgit-sync" } },
    );
    if (r.ok && r.body) {
      resp = r;
      used = b;
      break;
    }
  }
  if (!resp) fail(404, "无法从 GitHub 下载该仓库（可能不存在或非公开）");
  const files = await readTar(resp, sink);
  if (!files) fail(400, "该 GitHub 仓库没有可同步的文件");
  return { owner, name, branch: used, files };
}
