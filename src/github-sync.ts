import { HTTPException } from "hono/http-exception";
import { fail } from "./security";

/** 单文件与仓库总量上限，均为解压后的原始字节。 */
const MAX_FILE = 12 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
/**
 * 文件数上限。一次同步在单个请求内完成，解析与落库都占用脚本执行时间，
 * 超出后请求会因运行时限制中断，因此在下载归档之前先用 GitHub 的树列表预检。
 */
const MAX_FILES = 600;
/**
 * 每个文件缓冲前预留的字节数。git 对象内容为 `blob <len>\0` 加正文，
 * 预留头部后可以在原缓冲上就地拼接，交付出去的视图不必再复制一份正文。
 */
export const BLOB_HEADER_RESERVE = 32;
/** 每个批次的原始字节与文件数上限，避免单个请求内的存储调用超过运行时配额。 */
const BATCH_BYTES = 4 * 1024 * 1024;
const BATCH_FILES = 200;

export interface SyncFile {
  path: string;
  data: Uint8Array;
  mode: string;
}

export interface SkippedFile {
  path: string;
  size: number;
}

export interface GithubSnapshotInfo {
  owner: string;
  name: string;
  branch: string;
  files: number;
  /** 超过单文件上限而被跳过的条目，整仓仍然按其余文件完成同步。 */
  skipped: SkippedFile[];
}

export type SyncBatchSink = (files: SyncFile[]) => Promise<void>;

const textDecoder = new TextDecoder();
function cstr(data: Uint8Array): string {
  const end = data.indexOf(0);
  return textDecoder.decode(end < 0 ? data : data.subarray(0, end));
}

export function bytesToBase64(data: Uint8Array): string {
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
  /** 按声明大小一次性分配，边读边写，避免分片数组与最终拼接同时驻留 */
  buffer: Uint8Array;
};

const strip = (n: string) => {
  const i = n.indexOf("/");
  return i < 0 ? n : n.slice(i + 1);
};

/**
 * 流式解析归档：解压、拆包、分批交出去，任何时刻只保留一个批次和当前文件。
 * 返回文件总数。
 */
async function readTar(
  resp: Response,
  sink: SyncBatchSink,
): Promise<{ count: number; skipped: SkippedFile[] }> {
  if (!resp.body) fail(503, "GitHub 未返回归档内容");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = resp.body
      .pipeThrough(new DecompressionStream("gzip"))
      .getReader();
  } catch {
    fail(503, "解压 GitHub 归档失败");
  }
  // 分块队列：解压流有时一次吐出很大的数据块，不能每轮都整体复制。
  const queue: Uint8Array[] = [];
  let qoff = 0;
  let qlen = 0;
  let batch: SyncFile[] = [];

  const pushChunk = (value: Uint8Array) => {
    if (!value.length) return;
    queue.push(value);
    qlen += value.length;
  };
  const peek = (n: number) => {
    const first = queue[0];
    if (first && first.length - qoff >= n) return first.subarray(qoff, qoff + n);
    const out = new Uint8Array(n);
    let filled = 0;
    for (let i = 0; i < queue.length && filled < n; i++) {
      const chunk = i === 0 ? queue[0].subarray(qoff) : queue[i];
      const take = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
    }
    return out;
  };
  const takePart = (want: number) => {
    const first = queue[0];
    const avail = first.length - qoff;
    if (avail <= want) {
      const part = qoff ? first.subarray(qoff) : first;
      queue.shift();
      qoff = 0;
      qlen -= part.length;
      return part;
    }
    const part = first.subarray(qoff, qoff + want);
    qoff += want;
    qlen -= want;
    return part;
  };
  const discard = (n: number) => {
    let left = n;
    while (left > 0) left -= takePart(left).length;
  };
  let batchBytes = 0;
  let total = 0,
    count = 0;
  let paxPath: string | undefined;
  let pending: Pending | null = null;
  const skipped: SkippedFile[] = [];

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
    if (count > MAX_FILES)
      fail(
        413,
        `仓库超过 ${MAX_FILES} 个文件，请改用 git push 同步`,
      );
    // 大文件不与现有批次合并，保证单次请求的体积不超过一个批次预算。
    if (batch.length && batchBytes + data.length > BATCH_BYTES) await flushBatch();
    batch.push({
      path,
      data,
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
          if (!qlen) return;
          const take = Math.min(pending.remaining, qlen),
            contentTake = Math.min(take, pending.content - pending.got);
          let need = contentTake;
          while (need > 0) {
            const part = takePart(need);
            if (pending.kind !== "skip")
              pending.buffer.set(part, pending.got + BLOB_HEADER_RESERVE);
            pending.got += part.length;
            need -= part.length;
          }
          let skip = take - contentTake;
          while (skip > 0) skip -= takePart(skip).length;
          pending.remaining -= take;
          continue;
        }
        const job = pending;
        pending = null;
        if (job.kind === "pax") {
          for (const line of textDecoder
            .decode(
              job.buffer.subarray(
                BLOB_HEADER_RESERVE,
                BLOB_HEADER_RESERVE + job.content,
              ),
            )
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
        await pushFile(
          full,
          job.mode,
          job.buffer.subarray(
            BLOB_HEADER_RESERVE,
            BLOB_HEADER_RESERVE + job.content,
          ),
        );
        continue;
      }
      if (qlen < 512) return;
      const header = peek(512);
      discard(512);
      if (header.every((b) => b === 0)) return;
      const hname = cstr(header.subarray(0, 100));
      const mode = parseInt(cstr(header.subarray(100, 108)).trim() || "0", 8);
      const size = parseInt(cstr(header.subarray(124, 136)).trim() || "0", 8);
      const type = header[156];
      const prefix = cstr(header.subarray(345, 500));
      const full = prefix ? prefix + "/" + hname : hname;
      if (!Number.isSafeInteger(size) || size < 0) fail(400, "归档数据损坏");
      if (size > MAX_FILE) {
        // 大文件跳过而不是整仓失败：其余文件仍然可以完整同步。
        skipped.push({ path: strip(full), size });
        pending = {
          kind: "skip",
          path: full,
          mode,
          remaining: Math.ceil(size / 512) * 512,
          content: size,
          got: 0,
          buffer: new Uint8Array(0),
        };
        continue;
      }
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
        buffer: new Uint8Array(size + BLOB_HEADER_RESERVE),
      };
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value?.length) pushChunk(value);
      await drain();
      if (done) break;
    }
    await flushBatch();
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    console.error("GitHub archive parse failed", e);
    fail(503, "解压 GitHub 归档失败：" + ((e as Error)?.message || "未知错误"));
  }
  return { count, skipped };
}

/**
 * 用 GitHub 的树列表预先统计文件数：超限的仓库在下载归档之前就被拒绝，
 * 不必等解析到一半才失败。接口不可用时返回 null，改由解析过程兜底。
 */
async function countBlobs(
  owner: string,
  name: string,
  branch: string,
): Promise<number | null> {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      {
        headers: {
          "user-agent": "zq-cfgit-sync",
          accept: "application/vnd.github+json",
        },
      },
    );
    if (!r.ok) return null;
    const info = (await r.json()) as {
      tree?: { type?: string }[];
      truncated?: boolean;
    };
    if (!Array.isArray(info.tree)) return null;
    if (info.truncated) return Number.MAX_SAFE_INTEGER;
    return info.tree.filter((e) => e.type === "blob").length;
  } catch {
    return null;
  }
}

/** 下载并流式解析 GitHub 仓库快照，每累计一个批次调用一次 sink。 */
export async function streamGithubSnapshot(
  source: string,
  sink: SyncBatchSink,
): Promise<GithubSnapshotInfo> {
  const { owner, name } = parseSource(source);
  const wanted = await defaultBranch(owner, name);
  const files = await countBlobs(owner, name, wanted);
  if (files !== null && files > MAX_FILES)
    fail(
      413,
      `仓库有 ${files === Number.MAX_SAFE_INTEGER ? "超过" + MAX_FILES : files} 个文件，超过单次同步上限 ${MAX_FILES} 个，请改用 git push 同步`,
    );
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
  const { count, skipped } = await readTar(resp, sink);
  if (!count) fail(400, "该 GitHub 仓库没有可同步的文件");
  return { owner, name, branch: used, files: count, skipped };
}
