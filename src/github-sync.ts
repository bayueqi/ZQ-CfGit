import { fail } from "./security";

/** 单文件与仓库总量的保守上限（base64 后仍须落在 body 上限内）。 */
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_FILES = 3000;

export interface SyncFile {
  path: string;
  data: string;
  mode: string;
}

export interface GithubSnapshot {
  owner: string;
  name: string;
  branch: string;
  files: SyncFile[];
}

function cstr(data: Uint8Array): string {
  const end = data.indexOf(0);
  return new TextDecoder().decode(end < 0 ? data : data.subarray(0, end));
}

function bytesToBase64(data: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < data.length; i += 0x8000)
    bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(bin);
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

function parseTar(data: Uint8Array): SyncFile[] {
  const files: SyncFile[] = [];
  let pos = 0,
    paxPath: string | undefined,
    total = 0;
  const strip = (n: string) => {
    const i = n.indexOf("/");
    return i < 0 ? n : n.slice(i + 1);
  };
  while (pos + 512 <= data.length) {
    const header = data.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) break;
    const name = cstr(header.subarray(0, 100)),
      size = parseInt(cstr(header.subarray(124, 136)).trim() || "0", 8),
      mode = parseInt(cstr(header.subarray(100, 108)).trim() || "0", 8),
      type = header[156],
      prefix = cstr(header.subarray(345, 500));
    let full = prefix ? prefix + "/" + name : name;
    const content = data.subarray(pos + 512, pos + 512 + size);
    pos += 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || size < 0 || pos > data.length)
      fail(400, "归档数据损坏");
    if (type === 120 || type === 103) {
      for (const line of new TextDecoder().decode(content).split("\n")) {
        const m = line.match(/^\d+ path=(.*)$/);
        if (m) paxPath = m[1];
      }
      continue;
    }
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
    if (type === 53) continue;
    if (type !== 0 && type !== 48) continue;
    if (size > MAX_FILE) fail(413, "文件过大：" + full);
    total += size;
    if (total > MAX_TOTAL) fail(413, "仓库过大，无法一次性同步");
    if (files.length >= MAX_FILES) fail(413, "文件数量过多，无法一次性同步");
    files.push({
      path: full,
      data: bytesToBase64(content),
      mode: mode & 0o111 ? "100755" : "100644",
    });
  }
  return files;
}

export async function fetchGithubSnapshot(source: string): Promise<GithubSnapshot> {
  const { owner, name } = parseSource(source);
  let branch = "main";
  try {
    const meta = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
      headers: {
        "user-agent": "zq-cfgit-sync",
        accept: "application/vnd.github+json",
      },
    });
    if (meta.ok) {
      const info = (await meta.json()) as { default_branch?: string };
      if (info.default_branch) branch = info.default_branch;
    }
  } catch {
    /* 查询默认分支失败则回退 main */
  }
  const candidates = [branch, "main", "master"].filter(
    (b, i, a) => a.indexOf(b) === i,
  );
  let resp: Response | null = null,
    used = "main";
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
  if (!resp)
    fail(404, "无法从 GitHub 下载该仓库（可能不存在或非公开）");
  let raw: Uint8Array;
  try {
    const stream = resp.body!.pipeThrough(new DecompressionStream("gzip"));
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    fail(503, "解压 GitHub 归档失败");
  }
  const files = parseTar(raw);
  if (!files.length) fail(400, "该 GitHub 仓库没有可同步的文件");
  return { owner, name, branch: used, files };
}
