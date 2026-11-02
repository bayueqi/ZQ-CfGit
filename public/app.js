import {
  text as i18nText,
  html as i18nHTML,
  getLocale,
  errorText,
  relativeTime,
} from "./i18n.js?v=575ef2cba56d5e2e";
import { forgePage } from "./forge.js?v=c8814fff5c2601e5";
const root = document.querySelector("#app");
const esc = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icons = {
  repo: "M4 3h13a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z M3 17h16 M7 7h8 M7 10h6",
  plus: "M12 5v14 M5 12h14",
  code: "M8 6l-6 6 6 6 M16 6l6 6-6 6",
  folder: "M3 5h6l2 3h10v12H3z",
  file: "M5 3h9l5 5v13H5z M14 3v6h5",
  branch: "M6 3v12a4 4 0 0 0 8 0V9 M3 3h6 M11 6h6v3h-6z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16 M21 21l-4.3-4.3",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || icons.repo}"/></svg>`;
const date = (s) =>
  new Date(s.includes("T") ? s : s + "Z").toLocaleDateString(getLocale(), {
    month: "short",
    day: "numeric",
  });
let user = null,
  setup = false,
  routeVersion = 0;
let booting = true,
  hasRendered = false,
  navigation = new AbortController(),
  cacheEpoch = 0;
const pendingReads = new Map(),
  repositoryMetadata = new Map(),
  primedReads = new Map();
async function api(path, options = {}) {
  const reading = !options.method || options.method === "GET";
  if (reading && primedReads.has(path)) {
    const promise = primedReads.get(path);
    primedReads.delete(path);
    return promise;
  }
  const metadata = reading && /^\/repos\/[^/]+\/[^/]+$/.test(path);
  if (metadata) {
    const cached = repositoryMetadata.get(path);
    if (cached && cached.expires > Date.now()) return cached.data;
  }
  if (reading && pendingReads.has(path)) return pendingReads.get(path);
  if (!reading) {
    cacheEpoch++;
    repositoryMetadata.clear();
    pendingReads.clear();
    primedReads.clear();
  }
  const epoch = cacheEpoch;
  const request = (async () => {
    const r = await fetch("/api" + path, {
      ...options,
      signal: options.signal || (reading ? navigation.signal : undefined),
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await r.json();
    if (!r.ok) {
      if ([401, 403, 404].includes(r.status)) repositoryMetadata.clear();
      const error = new Error(
        errorText(data.error) +
          (data.details
            ? (getLocale() === "en" ? ": " : "：") +
              data.details
                .map((i) => errorText(i.message))
                .join(getLocale() === "en" ? "; " : "；")
            : ""),
      );
      error.status = r.status;
      throw error;
    }
    if (metadata && epoch === cacheEpoch) {
      if (repositoryMetadata.size >= 20)
        repositoryMetadata.delete(repositoryMetadata.keys().next().value);
      repositoryMetadata.set(path, { data, expires: Date.now() + 15000 });
    }
    return data;
  })();
  if (reading) pendingReads.set(path, request);
  try {
    return await request;
  } finally {
    if (pendingReads.get(path) === request) pendingReads.delete(path);
    if (!reading) {
      cacheEpoch++;
      repositoryMetadata.clear();
    }
  }
}

let selectedSpace = new URLSearchParams(location.search).get("namespace") || "";
const namespaceQuery = () =>
  selectedSpace ? "&namespace=" + encodeURIComponent(selectedSpace) : "";
function codeViewer(code, path) {
  return `<div class="code-viewer"><pre class="line-numbers" aria-hidden="true">${code
    .split("\n")
    .map((_, i) => `<span id="L${i + 1}">${i + 1}</span>`)
    .join(
      "\n",
    )}</pre><pre><code id="highlight-target" data-path="${esc(path)}">${esc(code)}</code></pre></div>`;
}
async function applyHighlight() {
  const target = document.querySelector("#highlight-target");
  if (!target) return;
  const raw = target.textContent;
  const { highlightCode } = await import("./highlight.js?v=42546bacb8cbde94");
  const html = highlightCode(raw, target.dataset.path);
  if (target.isConnected && html !== null) target.innerHTML = html;
}

async function applyMarkdown(context = {}) {
  const targets = [...document.querySelectorAll("[data-markdown]")].filter(
    (el) => !el.dataset.rendered,
  );
  if (!targets.length) return;
  const { renderMarkdown } = await import("./markdown.js?v=5c1e11be8f51b2f5");
  for (const el of targets) {
    if (!el.isConnected) continue;
    const raw = el.textContent;
    el.innerHTML = renderMarkdown(raw, {
      ...context,
      base: el.dataset.base || context.base,
      ref: el.dataset.ref || context.ref,
      path: el.dataset.file || "README.md",
    });
    el.dataset.rendered = "1";
  }
  const code = targets.flatMap((el) => [
    ...el.querySelectorAll('pre code[class*="language-"]'),
  ]);
  if (code.length) {
    const { highlightCode } = await import("./highlight.js?v=42546bacb8cbde94");
    for (const el of code) {
      const lang = [...el.classList]
          .find((c) => c.startsWith("language-"))
          .slice(9),
        aliases = {
          javascript: "js",
          typescript: "ts",
          python: "py",
          bash: "sh",
          shell: "sh",
          rust: "rs",
          markdown: "md",
          cpp: "cpp",
          yaml: "yaml",
        };
      const html = highlightCode(
        el.textContent,
        "file." + (aliases[lang] || lang),
      );
      if (el.isConnected && html !== null) el.innerHTML = html;
    }
  }
}
function loadingContent(title = i18nText("项目")) {
  return i18nHTML`<div class="titlebar"><h1>${esc(title)}</h1></div><section class="panel page-loading" aria-busy="true" aria-label="正在加载${esc(title)}"><div class="skeleton skeleton-heading"></div>${'<div class="skeleton skeleton-row"></div>'.repeat(5)}<span class="sr-only" role="status">正在加载${esc(title)}</span></section>`;
}
function browseURL(ap) {
  const q = new URLSearchParams(location.search),
    params = new URLSearchParams({
      path: q.get("path") || "",
      view: q.get("view") === "blob" ? "blob" : "tree",
    });
  if (q.get("ref")) params.set("ref", q.get("ref"));
  return ap + "/browse?" + params;
}
function primeRoute() {
  const path = location.pathname,
    parts = path.split("/").filter(Boolean);
  const reads = [];
  if (path === "/") {
    const q = new URLSearchParams(location.search);
    reads.push(
      "/repos?q=" +
        encodeURIComponent(q.get("q") || "") +
        "&page=" +
        (Number(q.get("page")) || 0) +
        namespaceQuery(),
    );
  } else if (
    parts.length >= 2 &&
    !["settings", "admin"].includes(parts[0])
  ) {
    const ap = "/repos/" + parts[0] + "/" + parts[1];
    reads.push(ap);
    if (!parts[2]) reads.push(browseURL(ap));
    else if (parts[2] === "commits")
      reads.push(ap + "/" + parts[2] + (parts[3] ? "/" + parts[3] : ""));
  }
  // Attach rejection handlers immediately; the page awaits the same in-flight reads.
  for (const path of reads) {
    const promise = api(path);
    primedReads.set(path, promise);
    promise.catch(() => {});
  }
}

function notice(message) {
  const n = document.querySelector("#notice");
  n.textContent = message;
  n.className = "notice-visible";
  setTimeout(() => {
    n.className = "";
    n.textContent = "";
  }, 4500);
}
function go(path) {
  history.pushState({}, "", path);
  render();
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    go(a.getAttribute("href"));
  }
});
window.addEventListener("popstate", render);
const link = (path, label, cls = "") =>
  `<a data-link href="${esc(path === "/" && user && selectedSpace ? "/?namespace=" + encodeURIComponent(selectedSpace) : path)}" class="${cls}">${label}</a>`;
function layout(content, crumb = i18nText("项目")) {
  const heading = (crumb || "").trim() || i18nText("项目");
  document.title = heading + " · ZQ-CfGit";
  root.innerHTML = i18nHTML`<main class="main"><header class="topbar">${link("/", '<img src="/logo.png" alt="">ZQ-CfGit', "brand")}<div class="breadcrumb"><span>${esc(heading)}</span></div><div class="right">${link("/", i18nText("项目"), "toplink")}${user ? link("/settings/tokens", i18nText("访问令牌"), "toplink") : ""}${user ? i18nHTML`<span class="avatar" title="${esc(user.username)}">${esc(user.username[0].toUpperCase())}</span><button class="text" id="logout">退出</button>` : link("/login", i18nText("登录"), "btn small")}</div></header><div class="content">${content}</div></main>`;
  document.querySelector("#logout")?.addEventListener("click", async () => {
    await api("/logout", { method: "POST" });
    user = null;
    selectedSpace = "";
    go("/login");
  });
}
function bindForm(id, handler) {
  const form = document.querySelector(id);
  form?.querySelectorAll("input,textarea,select").forEach((input, i) => {
    if (!input.id || input.id === input.name)
      input.id = form.id + "-" + (input.name || i);
    const label = input.closest(".field")?.querySelector("label");
    if (label) label.htmlFor = input.id;
  });
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("[type=submit]");
    const error = form.querySelector(".error");
    if (error) error.remove();
    btn.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(form)), form);
    } catch (e) {
      const div = document.createElement("div");
      div.className = "error";
      div.textContent = e.message;
      form.prepend(div);
    } finally {
      btn.disabled = false;
    }
  });
}
function field(label, name, type = "text", value = "", hint = "") {
  return `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${esc(value)}" required ${type === "password" ? 'minlength="12" maxlength="128" autocomplete="current-password"' : ""}>${hint ? `<p class="hint">${hint}</p>` : ""}</div>`;
}
const textarea = (label, name, value = "", cls = "") =>
  `<div class="field"><label for="${name}">${label}</label><textarea name="${name}" id="${name}" class="${cls}">${esc(value)}</textarea></div>`;
function authPage() {
  const initializing = setup;
  document.title =
    (initializing ? i18nText("初始化") : i18nText("登录")) + " · ZQ-CfGit";
  root.innerHTML = i18nHTML`<main class="auth"><section class="auth-story"><a href="/" class="brand" data-link><img src="/logo.png" alt="">ZQ-CfGit</a><div><h1>代码的归属，<br><span>由你定义。</span></h1><p>从第一个 commit 到下一次合并。把仓库、讨论与协作，留在自己的空间。</p><div class="lines">$ git add .<br>$ git commit -m "a new beginning"<br>$ git push origin main</div></div></div></section><section class="auth-form"><form id="login-form"><h2>${initializing ? i18nText("初始化") : i18nText("欢迎回来")}</h2><p class="muted">${initializing ? i18nText("使用部署时配置的初始化密钥创建管理员。") : i18nText("登录 ZQ-CfGit，继续你的下一个想法。")}</p>${initializing ? field(i18nText("初始化密钥"), "secret", "password") : ""}${field(i18nText("用户名"), "username")}${field(i18nText("密码"), "password", "password", "", i18nText("至少 12 个字符"))}<button type="submit" class="btn primary">${initializing ? i18nText("初始化 ZQ-CfGit") : i18nText("登录")} →</button>${!initializing ? link("/", i18nText("浏览公开项目 →")) : ""}</form></section></main>`;
  bindForm("#login-form", async (data) => {
    if (initializing) {
      await api("/setup", { method: "POST", body: data });
      setup = false;
    }
    user = await api("/login", {
      method: "POST",
      body: { username: data.username, password: data.password },
    });
    go("/");
  });
}
async function projects(version) {
  const query = new URLSearchParams(location.search),
    q = query.get("q") || "",
    page = Number(query.get("page")) || 0;
  const { repositories } = await api(
    `/repos?q=${encodeURIComponent(q)}&page=${page}${namespaceQuery()}`,
  );
  if (version !== routeVersion) return;
  layout(
    i18nHTML`<div class="titlebar"><div><h1>项目</h1><p class="muted">每一个想法，都从一个仓库开始。</p></div>${user ? link("/new", icon("plus") + i18nText("新建项目"), "btn primary") : link("/login", i18nText("登录以创建项目"), "btn primary")}</div><div class="stats"><div class="stat"><div class="muted">当前列表</div><div class="number">${repositories.length}<span>个项目</span></div></div><div class="stat"><div class="muted">公开项目</div><div class="number">${repositories.filter((r) => r.visibility === "public").length}<span>开放协作</span></div></div><div class="stat"><div class="muted">私有项目</div><div class="number">${repositories.filter((r) => r.visibility === "private").length}<span>受控访问</span></div></div></div><form class="toolbar" id="search"><div class="search"><input name="q" value="${esc(q)}" placeholder="搜索项目名称或描述…" aria-label="搜索项目"></div><button class="btn" type="submit">搜索</button></form><div class="panel"><div class="panelhead"><strong>${q ? i18nText("搜索结果") : i18nText("所有可访问项目")}</strong><span class="muted">${repositories.length} 个项目</span></div>${repositories.length ? repositories.map((r) => i18nHTML`<article class="repo-row"><div class="repo-icon">${icon("repo")}</div><div class="repo-info">${link(`/${r.namespace}/${encodeURIComponent(r.name)}`, `<span class="namespace">${esc(r.namespace)} / </span>${esc(r.name)}`, "repo-name")}${r.archived_at ? '<span class="pill archived">' + i18nText("已归档") + "</span>" : ""}<p>${esc(r.description || i18nText("这个项目还没有描述。"))}</p><div class="rowmeta"><span><i class="dot"></i>Git</span><span>${esc(r.default_branch)}</span><span>创建于 ${date(r.created_at)}</span></div></div><span class="pill">${r.visibility === "private" ? i18nText("私有") : i18nText("公开")}</span></article>`).join("") : `<div class="empty">${icon("repo")}<h2>${q ? i18nText("没有找到匹配的项目") : i18nText("让第一个想法落地")}</h2><p>${q ? i18nText("试试其他项目名称或描述关键词。") : i18nText("创建一个仓库，用 Git 推送代码，邀请伙伴一起构建。")}</p>${user && !q ? link("/new", i18nText("创建第一个项目"), "btn primary") : ""}</div>`}</div><div class="page-nav">${page > 0 ? link(`/?page=${page - 1}&q=${encodeURIComponent(q)}${namespaceQuery()}`, i18nText("← 上一页"), "btn small") : "<span></span>"}${repositories.length === 50 ? link(`/?page=${page + 1}&q=${encodeURIComponent(q)}${namespaceQuery()}`, i18nText("下一页 →"), "btn small") : ""}</div><p class="footer-note">你的代码，存放在你自己的 Cloudflare 账户。</p>`,
  );
  document.querySelector("#search").onsubmit = (e) => {
    e.preventDefault();
    go(
      "/?q=" +
        encodeURIComponent(new FormData(e.target).get("q")) +
        namespaceQuery(),
    );
  };
}
async function newProject() {
  if (!user) return go("/login");
  layout(
    i18nHTML`<div class="titlebar"><div><h1>新建项目</h1><p class="muted">为下一件值得构建的事，留一个位置。</p></div></div><div class="panel"><form class="form" id="create">${field(i18nText("项目名称"), "name", "text", "", i18nText("支持小写字母、数字、短横线、下划线和最多 5 层分组路径，例如 team/project。"))}${textarea(i18nText("项目描述"), "description")}<div class="inline"><div class="field"><label for="visibility">可见性</label><select id="visibility" name="visibility"><option value="private">私有 · 仅成员可访问</option><option value="public">公开 · 所有人可读取</option></select></div>${field(i18nText("默认分支"), "default_branch", "text", "main")}</div><button type="submit" class="btn primary">创建项目</button></form></div>`,
    i18nText("新建项目"),
  );
  bindForm("#create", async (data) => {
    const r = await api("/repos", { method: "POST", body: data });
    go(`/${r.namespace}/${encodeURIComponent(r.name)}`);
  });
}
let currentRepo = null;
function repoLayout(r, tab, content, actions = "") {
  currentRepo = r;
  if (user) selectedSpace = r.namespace;
  const base = `/${r.namespace}/${encodeURIComponent(r.name)}`;
  layout(
    i18nHTML`<div class="titlebar"><div><div class="inline"><h1>${esc(r.name)}</h1><span class="pill">${r.visibility === "public" ? i18nText("公开") : i18nText("私有")}</span></div><p class="muted">${esc(r.description || i18nText("添加描述，让伙伴了解这个项目。"))}</p></div>${actions}</div><nav class="tabs" aria-label="项目导航">${[
      ["code", i18nText("代码"), ""],
      ["commits", i18nText("提交"), "/commits"],
      ["forge", i18nText("Git 工具"), "/forge"],
      ["search", i18nText("搜索"), "/search"],
      ...(["owner", "maintainer"].includes(r.role)
        ? [["settings", i18nText("设置"), "/settings"]]
        : []),
    ]
      .map(([key, label, path]) =>
        link(base + path, label, `tab ${tab === key ? "active" : ""}`),
      )
      .join(
        "",
      )}</nav>${r.archived_at ? i18nText('<div class="info" role="status">此项目已归档：代码与历史记录可读，协作写入和流水线已暂停。项目所有者可在设置中恢复。</div>') : ""}${content}`,
    `${r.namespace} / ${r.name}`,
  );
}
function copyButton(value, id = "copy") {
  document.querySelector("#" + id)?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      notice(i18nText("已复制到剪贴板"));
    } catch {
      notice(i18nText("无法访问剪贴板，请手动复制。"));
    }
  });
}
const writeable = (r) =>
  !r.archived_at && ["owner", "maintainer", "developer"].includes(r.role);
async function codePage(r, base, ap, version) {
  const params = new URLSearchParams(location.search),
    p = params.get("path") || "",
    blob = params.get("view") === "blob";
  const {
    branches,
    data,
    readme: readmeFile,
    default_branch,
  } = await api(browseURL(ap));
  const ref = params.get("ref") || default_branch;
  r = { ...r, default_branch };
  if (version !== routeVersion) return;
  const clone = i18nHTML`<button class="btn" id="copy">克隆地址 ↗</button>`;
  const aside = i18nHTML`<aside class="aside"><section><h3>关于项目</h3><p class="muted">${esc(r.description || i18nText("暂无描述"))}</p><span class="pill">${r.visibility === "public" ? i18nText("公开仓库") : i18nText("私有仓库")}</span></section><section><h3>使用 Git 克隆</h3><code>${esc(r.clone_url)}</code><p class="muted">HTTPS 凭证：用户名 + 访问令牌</p>${link("/settings/tokens", i18nText("管理访问令牌 →"))}</section><section><h3>仓库详情</h3><p class="muted">${branches.length} 个分支<br>默认分支 ${esc(r.default_branch)}<br>创建于 ${date(r.created_at)}</p></section></aside>`;
  if (!branches.length) {
    repoLayout(
      r,
      "code",
      i18nHTML`<div class="grid"><div class="panel"><div class="empty">${icon("code")}<h2>第一行代码，从这里开始</h2><p>仓库已准备好。推送现有项目，或者在线创建第一个文件。</p>${writeable(r) ? link(base + "/edit", i18nText("创建 README"), "btn primary") : ""}</div><pre>git init -b ${esc(r.default_branch)}
git add .
git commit -m "Initial commit"
git remote add origin ${esc(r.clone_url)}
git push -u origin ${esc(r.default_branch)}</pre></div>${aside}</div>`,
      clone,
    );
    copyButton(r.clone_url);
    return;
  }
  const readme = readmeFile?.content
    ? `<section class="panel readme"><div class="panelhead"><strong>README.md</strong></div><div class="markdown detail-body" data-markdown data-base="${esc(base)}" data-ref="${esc(data.ref)}" data-file="README.md">${esc(readmeFile.content)}</div></section>`
    : "";
  if (version !== routeVersion) return;
  const nav = i18nHTML`<div class="toolbar"><div class="actionbar"><select class="select-branch" id="branch" aria-label="选择分支">${!branches.some((b) => b.name === ref) ? i18nHTML`<option selected value="${esc(ref)}">提交 ${esc(ref.slice(0, 12))}</option>` : ""}${branches.map((b) => `<option ${b.name === ref ? "selected" : ""} value="${esc(b.name)}">⑂ ${esc(b.name)}</option>`).join("")}</select><span class="muted">${esc(p || "/")}</span></div>${writeable(r) ? link(`${base}/edit?ref=${encodeURIComponent(ref)}${blob ? "&path=" + encodeURIComponent(p) : ""}`, blob ? i18nText("编辑文件") : i18nText("新建文件"), "btn small") : ""}</div>`;
  const up = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const list = blob
    ? `<div class="panelhead">${esc(p)}<span class="muted">${data.size} bytes</span></div>${/\.(png|jpe?g|gif|webp)$/i.test(p) ? i18nHTML`<div class="image-preview"><img id="blob-preview" alt="${esc(p)}" src="${esc("/api" + ap + "/preview?" + new URLSearchParams({ ref: data.ref, path: p }))}"><p class="muted" id="preview-caption">图片预览 · ${esc(p)}</p></div>` : data.binary ? i18nText('<div class="empty"><p>二进制文件，请通过 Git 下载。</p></div>') : /\.ipynb$/i.test(p) ? i18nText('<div id="notebook-preview"><p class="muted detail-body">正在加载笔记本预览…</p></div>') : /\.md$/i.test(p) ? i18nHTML`<div class="markdown detail-body" data-markdown data-base="${esc(base)}" data-ref="${esc(data.ref)}" data-file="${esc(p)}">${esc(data.content)}</div><details><summary>查看源码</summary>${codeViewer(data.content, p)}</details>` : codeViewer(data.content, p)}`
    : `<div class="panelhead"><span>${link(base + "?ref=" + encodeURIComponent(ref), esc(r.name))}${p ? " / " + esc(p) : ""}</span><code>${esc(data.ref.slice(0, 8))}</code></div>${p ? `<div class="file-row">${link(`${base}?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(up)}`, i18nText("← 上一级"))}<span></span></div>` : ""}${data.entries
        .sort(
          (a, b) =>
            (a.type === b.type ? 0 : a.type === "tree" ? -1 : 1) ||
            a.name.localeCompare(b.name),
        )
        .map(
          (f) =>
            `<div class="file-row">${link(`${base}?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent((p ? p + "/" : "") + f.name)}${f.type === "tree" ? "" : "&view=blob"}`, icon(f.type === "tree" ? "folder" : "file") + esc(f.name))}<span class="file-meta"><code class="muted">${f.sha.slice(0, 8)}</code><time class="file-updated muted" data-file-updated="${esc(f.name)}" title="${esc(i18nText("正在读取更新时间"))}">…</time></span></div>`,
        )
        .join("")}`;
  repoLayout(
    r,
    "code",
    nav +
      `<div class="grid"><div><div class="panel">${list}</div>${readme}</div>${aside}</div>`,
    clone,
  );
  if (!blob) void loadFileUpdates(ap, data.ref, p, version);
  const notebook = document.querySelector("#notebook-preview");
  if (notebook) {
    try {
      const { mountNotebook } =
        await import("./notebook.js?v=9c70f835d567613c");
      if (version !== routeVersion || !notebook.isConnected) return;
      mountNotebook(notebook, data.content, { base, ref: data.ref, path: p });
    } catch {
      if (notebook.isConnected)
        notebook.textContent = i18nText(
          "无法加载笔记本预览，请刷新或通过 Git 查看源码。",
        );
    }
  }
  const preview = document.querySelector("#blob-preview");
  if (preview) {
    const failed = () => {
      preview.hidden = true;
      document.querySelector("#preview-caption").textContent = i18nText(
        "无法预览：仅支持有效的 PNG、JPEG、GIF、WebP 图片，且不超过 5 MiB。",
      );
    };
    preview.addEventListener("error", failed);
    if (preview.complete && !preview.naturalWidth) failed();
  }
  copyButton(r.clone_url);
  applyHighlight().catch(() => {});
  if (/^#L[1-9][0-9]*$/.test(location.hash)) {
    const line = document.getElementById(location.hash.slice(1));
    const details = line?.closest("details");
    if (details) details.open = true;
    line?.scrollIntoView({ block: "center" });
  }
  document.querySelector("#branch").onchange = (e) =>
    go(`${base}?ref=${encodeURIComponent(e.target.value)}`);
}
async function loadFileUpdates(ap, sha, path, version) {
  const url = `${ap}/tree-updates?ref=${encodeURIComponent(sha)}&path=${encodeURIComponent(path)}`;
  const rows = new Map(
    [...document.querySelectorAll("[data-file-updated]")].map((el) => [
      el.dataset.fileUpdated,
      el,
    ]),
  );
  try {
    for (let batch = 0; batch < 626 && version === routeVersion; batch++) {
      const result = await api(url);
      if (
        version !== routeVersion ||
        result.ref !== sha ||
        result.path !== path
      )
        return;
      for (const update of result.updates) {
        const el = rows.get(update.name);
        if (!el?.isConnected || !update.date) continue;
        el.dateTime = update.date;
        el.textContent = relativeTime(update.date);
        el.title = new Date(update.date).toLocaleString(getLocale());
      }
      if (result.complete || result.limited) break;
    }
  } catch (error) {
    if (version !== routeVersion || error.name === "AbortError") return;
  }
  for (const el of rows.values())
    if (el.isConnected && !el.dateTime) {
      el.textContent = "—";
      el.title = i18nText("更新时间暂不可用，可在文件历史中查看");
    }
}
async function searchPage(r, base, ap, version) {
  const q = new URLSearchParams(location.search).get("q") || "";
  const result = q
    ? await api(ap + "/search?q=" + encodeURIComponent(q))
    : { matches: [] };
  if (version !== routeVersion) return;
  repoLayout(
    r,
    "search",
    i18nHTML`<form class="toolbar" id="code-search"><div class="search"><input name="q" value="${esc(q)}" required maxlength="128" placeholder="在默认分支搜索代码…" aria-label="搜索代码"></div><button class="btn primary" type="submit">搜索代码</button></form><div class="panel"><div class="panelhead"><strong>${result.matches.length} 处匹配</strong><span class="muted">${esc(r.default_branch)}${result.truncated ? i18nText(" · 仅显示前 200 条") : ""}</span></div>${result.matches.map((m) => `<div class="comment">${link(base + "?view=blob&path=" + encodeURIComponent(m.path), esc(m.path) + ":" + m.line)}<pre>${esc(m.text)}</pre></div>`).join("") || '<div class="empty"><p>' + (q ? i18nText("没有匹配的代码。") : i18nText("输入关键词，搜索仓库中的文本文件。")) + "</p></div>"}</div>`,
  );
  document.querySelector("#code-search").onsubmit = (e) => {
    e.preventDefault();
    go(
      base + "/search?q=" + encodeURIComponent(new FormData(e.target).get("q")),
    );
  };
}
async function editPage(r, base, ap, version) {
  if (!writeable(r)) throw Error(i18nText("需要项目写入权限。"));
  const params = new URLSearchParams(location.search),
    ref = params.get("ref") || r.default_branch,
    p = params.get("path") || "README.md";
  const { branches } = await api(ap + "/branches"),
    head = branches.find((b) => b.name === ref)?.sha || null;
  let content = "";
  if (params.has("path"))
    content =
      (
        await api(
          `${ap}/blob?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(p)}`,
        )
      ).content || "";
  else if (!head) content = `# ${r.name}\n\n${r.description}\n`;
  if (version !== routeVersion) return;
  repoLayout(
    r,
    "code",
    i18nHTML`<div class="panel"><div class="panelhead"><strong>${params.has("path") ? i18nText("编辑文件") : i18nText("新建文件")}</strong><span class="muted">${esc(ref)}</span></div><form class="form" id="edit">${field(i18nText("文件路径"), "path", "text", p)}${textarea(i18nText("文件内容"), "content", content, "editor")}${field(i18nText("提交说明"), "message", "text", params.has("path") ? "Update " + p : "Add " + p)}<button class="btn primary" type="submit">提交到 ${esc(ref)}</button></form></div>`,
  );
  bindForm("#edit", async (data) => {
    await api(ap + "/commit", {
      method: "POST",
      body: {
        branch: ref,
        expected_sha: head,
        message: data.message,
        files: [{ path: data.path, content: data.content }],
      },
    });
    go(base + "?ref=" + encodeURIComponent(ref));
    notice(i18nText("提交已保存"));
  });
}
async function commitsPage(r, base, ap, version) {
  const { commits } = await api(ap + "/commits");
  if (version !== routeVersion) return;
  repoLayout(
    r,
    "commits",
    i18nHTML`<div class="panel"><div class="panelhead"><strong>最近提交</strong><span class="muted">${esc(r.default_branch)}</span></div>${commits.length ? commits.map((c) => link(base + "/commits/" + c.sha, `<span class="avatar">${esc(c.author[0])}</span><div class="repo-info"><strong>${esc(c.message)}</strong><p>${esc(c.author)} · ${date(c.date)}</p></div><code>${c.sha.slice(0, 8)}</code>`, "repo-row")).join("") : `<div class="empty"><h2>暂无提交记录</h2></div>`}</div>`,
  );
}
function diffRows(patch) {
  const lines = String(patch || "").split("\n");
  let out = "",
    oldNo = 0,
    newNo = 0;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = +m[1];
        newNo = +m[2];
      }
      out += `<div class="review-diff-row hunk"><span></span><span></span><code>${esc(line)}</code></div>`;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      out += `<div class="review-diff-row added"><span></span><span>${newNo++}</span><code>${esc(line)}</code></div>`;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      out += `<div class="review-diff-row removed"><span>${oldNo++}</span><span></span><code>${esc(line)}</code></div>`;
    } else if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("\\")
    ) {
      continue;
    } else {
      out += `<div class="review-diff-row"><span>${oldNo++}</span><span>${newNo++}</span><code>${esc(line)}</code></div>`;
    }
  }
  return out;
}
async function commitPage(r, base, ap, version, sha) {
  const [{ commit }, diff] = await Promise.all([
    api(ap + "/commit?sha=" + encodeURIComponent(sha)),
    api(ap + "/diff?sha=" + encodeURIComponent(sha)),
  ]);
  if (version !== routeVersion) return;
  const msg = String(commit.message || "").split("\n"),
    title = msg[0] || "",
    body = msg.slice(1).join("\n").trim(),
    statusText = { added: "新增", deleted: "删除", modified: "修改" };
  repoLayout(
    r,
    "commits",
    i18nHTML`<div class="panel"><div class="panelhead"><strong>${esc(title)}</strong><code>${esc(commit.sha.slice(0, 8))}</code></div><p class="muted" style="padding:0 16px;margin:14px 0 0">${esc(commit.author_name)} 提交于 ${date(commit.date)}${commit.parent_shas?.length ? " · 父提交 " + commit.parent_shas.map((p) => link(base + "/commits/" + p, p.slice(0, 8))).join(", ") : ""}</p>${body ? `<pre style="padding:0 16px 16px">${esc(body)}</pre>` : '<div style="height:14px"></div>'}</div><div class="panel"><div class="panelhead"><strong>变更</strong><span class="muted">${diff.stats.files} 个文件 · +${diff.stats.additions} −${diff.stats.deletions}</span></div>${diff.files.length ? diff.files.map((f) => `<div class="panelhead" style="border-top:1px solid var(--line)"><span class="pill">${esc(statusText[f.status] || f.status)}</span><code>${esc(f.path)}</code></div>${f.binary ? '<p class="muted" style="padding:0 16px 16px">二进制文件</p>' : `<div class="review-diff">${diffRows(f.patch)}</div>`}`).join("") : '<div class="empty"><p>无文件变更</p></div>'}</div>`,
  );
}
async function settingsPage(r, base, ap, version) {
  const { events } = await api(ap + "/audit");
  if (version !== routeVersion) return;
  repoLayout(
    r,
    "settings",
    i18nHTML`<div class="stack">${r.role === "owner" ? i18nHTML`<div class="panel"><form class="form" id="project-lifecycle"><h2>${r.archived_at ? i18nText("恢复项目") : i18nText("归档项目")}</h2><p class="muted">归档后可继续 clone、下载和读取历史，但停止写入。</p><button type="submit" class="btn">${r.archived_at ? i18nText("取消归档") : i18nText("归档为只读")}</button></form></div>` : ""}${r.role === "owner" ? i18nHTML`<details class="panel"><summary class="panelhead">重命名项目</summary><form class="form" id="project-transfer">${field(i18nText("目标项目名"), "name", "text", r.name)}<button class="btn" type="submit">重命名</button></form></details>` : ""}<div class="panel"><form class="form" id="repo-settings"><h2>项目设置</h2>${textarea(i18nText("项目描述"), "description", r.description)}${field(i18nText("默认分支"), "default_branch", "text", r.default_branch)}<div class="field"><label for="visibility">可见性</label><select name="visibility" id="visibility"><option value="private" ${r.visibility === "private" ? "selected" : ""}>私有 · 仅成员可访问</option><option value="public" ${r.visibility === "public" ? "selected" : ""}>公开 · 所有人可读取</option></select></div><button class="btn primary" type="submit">保存设置</button></form></div><div class="panel"><div class="panelhead"><strong>审计记录</strong><span class="muted">最近 100 条</span></div>${events.map((e) => `<div class="token-row"><div><strong>${esc(e.action)}</strong><p class="muted">${esc(e.actor || "system")} · ${esc(e.detail)}</p></div><span class="muted">${date(e.created_at)}</span></div>`).join("")}</div></div>`,
  );
  bindForm("#project-transfer", async (data) => {
    const result = await api(ap + "/transfer", {
      method: "POST",
      body: {
        name: data.name,
        revision: r.lifecycle_revision,
      },
    });
    notice(i18nText("项目已重命名"));
    go(`/${result.namespace}/${encodeURIComponent(result.name)}/settings`);
  });
  bindForm("#project-lifecycle", async () => {
    await api(ap + "/lifecycle", {
      method: "PUT",
      body: { archived: !r.archived_at, revision: r.lifecycle_revision },
    });
    notice(r.archived_at ? i18nText("项目已恢复") : i18nText("项目已归档"));
    render();
  });
  if (r.archived_at)
    document
      .querySelectorAll(
        "#repo-settings input, #repo-settings textarea, #repo-settings select, #repo-settings button",
      )
      .forEach((el) => (el.disabled = true));
  bindForm("#repo-settings", async (data) => {
    await api(ap, { method: "PATCH", body: data });
    notice(i18nText("项目设置已保存"));
    render();
  });
}
async function tokensPage(version) {
  if (!user) return go("/login");
  const { tokens } = await api("/tokens");
  if (version !== routeVersion) return;
  layout(
    i18nHTML`<div class="titlebar"><div><h1>访问令牌</h1><p class="muted">为 Git 客户端和自动化工具创建凭证。</p></div></div><div class="info">Git 通过 HTTPS 使用你的用户名和令牌认证。令牌只显示一次；可随时撤销。</div><div id="token-result"></div><div class="stack"><details class="panel"><summary class="panelhead">修改账号密码</summary><form class="form" id="change-password">${field(i18nText("当前密码"), "current_password", "password")}${field(i18nText("新密码"), "new_password", "password", "", i18nText("修改后将撤销所有会话与访问令牌，需要重新登录。"))}<button type="submit" class="btn primary">修改密码</button></form></details><div class="panel"><form class="form" id="new-token"><h2>创建令牌</h2>${field(i18nText("名称"), "name", "text", "", i18nText("例如：MacBook、CI read-only"))}<div class="inline"><div class="field"><label for="scope">权限</label><select id="scope" name="scope"><option value="write">读写 · 使用账号已有权限</option><option value="read">只读</option></select></div><div class="field"><label for="days">有效期</label><select id="days" name="days"><option value="30">30 天</option><option value="90" selected>90 天</option><option value="365">365 天</option></select></div></div><button class="btn primary" type="submit">生成令牌</button></form></div><div class="panel"><div class="panelhead"><strong>已有令牌</strong></div>${tokens.length ? tokens.map((t) => i18nHTML`<div class="token-row"><div><strong>${esc(t.name)}</strong><p class="muted">${t.scope === "read" ? i18nText("只读") : i18nText("读写")} · 到期 ${new Date(t.expires_at).toLocaleDateString(getLocale())}</p></div><button class="btn small danger" data-revoke="${t.id}">撤销</button></div>`).join("") : i18nText('<div class="empty"><p>暂无访问令牌。</p></div>')}</div></div>`,
    i18nText("访问令牌"),
    "tokens",
  );
  bindForm("#change-password", async (data) => {
    await api("/password", { method: "POST", body: data });
    user = null;
    selectedSpace = "";
    go("/login");
    notice(i18nText("密码已更新，请重新登录。"));
  });
  bindForm("#new-token", async (data) => {
    const result = await api("/tokens", {
      method: "POST",
      body: { ...data, days: Number(data.days) },
    });
    document.querySelector("#token-result").innerHTML =
      i18nHTML`<div class="token-display">请现在保存令牌，离开页面后将无法再次查看。<code>${esc(result.token)}</code><button class="btn small" id="copy-token">复制令牌</button></div>`;
    copyButton(result.token, "copy-token");
  });
  document.querySelectorAll("[data-revoke]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api("/tokens/" + b.dataset.revoke, { method: "DELETE" });
          render();
          notice(i18nText("令牌已撤销"));
        } catch (e) {
          notice(e.message);
        }
      }),
  );
}
async function render() {
  if (booting) return;
  if (hasRendered) {
    navigation.abort();
    navigation = new AbortController();
    pendingReads.clear();
    primedReads.clear();
  }
  hasRendered = true;
  const version = ++routeVersion;
  const path = location.pathname;
  if (path === "/")
    selectedSpace = new URLSearchParams(location.search).get("namespace") || "";
  const titles = {
    tokens: i18nText("访问令牌"),
    commits: i18nText("提交"),
    forge: i18nText("Git 工具"),
    settings: i18nText("设置"),
    search: i18nText("搜索"),
    code: i18nText("代码"),
    new: i18nText("新建项目"),
    login: i18nText("登录"),
  };
  const segments = path.split("/").filter(Boolean),
    segment = segments.at(-1),
    repoPath =
      segments.length > 1 &&
      !["settings", "login", "new"].includes(segments[0]),
    title = repoPath
      ? `${segments[0]} / ${segments[1]}`
      : titles[segment] || i18nText("项目");
  layout(
    loadingContent(title),
    title,
    path.startsWith("/settings/") ? segment : "repos",
  );
  primeRoute();
  try {
    if (path === "/login" || setup) {
      authPage();
      return;
    }
    if (path === "/new") {
      await newProject();
      return;
    }
    const helpers = {
      api,
      layout,
      repoLayout,
      esc,
      field,
      textarea,
      bindForm,
      notice,
      render,
      go,
      icon,
      current: () => version === routeVersion,
      user,
      markdown: applyMarkdown,
    };
    if (path === "/settings/tokens") {
      await tokensPage(version);
      return;
    }
    if (path === "/") {
      await projects(version);
      return;
    }
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) throw Error(i18nText("页面不存在"));
    const [namespace, name, tab, sub] = parts,
      base = `/${namespace}/${name}`,
      ap = "/repos" + base;
    const r = await api(ap);
    if (version !== routeVersion) return;
    const canonical = `/${r.namespace}/${encodeURIComponent(r.name)}`;
    if (base !== canonical) {
      history.replaceState(
        {},
        "",
        canonical + path.slice(base.length) + location.search,
      );
      return render();
    }
    document.title = `${r.namespace} / ${r.name} · ZQ-CfGit`;
    repoLayout(
      r,
      tab || "code",
      loadingContent(titles[tab] || i18nText("文件")),
    );
    if (!tab) await codePage(r, base, ap, version);
    else if (tab === "forge") await forgePage(r, base, ap, helpers);
    else if (tab === "search") await searchPage(r, base, ap, version);
    else if (tab === "edit") await editPage(r, base, ap, version);
    else if (tab === "commits")
      sub
        ? await commitPage(r, base, ap, version, sub)
        : await commitsPage(r, base, ap, version);
    else if (tab === "settings") await settingsPage(r, base, ap, version);
    else throw Error(i18nText("页面不存在"));
    if (version === routeVersion)
      applyMarkdown({ base, ref: r.default_branch }).catch(() => {});
  } catch (e) {
    if (version !== routeVersion) return;
    layout(
      `<div class="error">${esc(e.message)}</div>${link("/", i18nText("返回项目列表"), "btn")}`,
      i18nText("暂时无法打开"),
    );
  }
}
layout(loadingContent(i18nText("项目")));
primeRoute();
try {
  const state = await api("/bootstrap", { signal: AbortSignal.timeout(20000) });
  user = state.user;
  setup = state.required;
  booting = false;
  await render();
} catch (e) {
  booting = false;
  layout(
    i18nHTML`<h1>暂时无法加载</h1><div class="error">${esc(e.message)}</div><button id="retry-start" class="btn primary">重试</button>`,
    i18nText("暂时无法加载"),
  );
  document.querySelector("#retry-start").onclick = () => location.reload();
}
