import {
  text as i18nText,
  html as i18nHTML,
} from "./i18n.js?v=3c48eba548be8390";
export async function forgePage(r, base, ap, h) {
  const { api, repoLayout, esc, field, textarea, bindForm, notice, go } = h;
  const ephemeral =
      new URLSearchParams(location.search).get("ephemeral") === "true",
    suffix = "?ephemeral=" + ephemeral;
  const [branches, tags] = await Promise.all([
    api(ap + "/branches" + suffix),
    api(ap + "/tags" + suffix),
  ]);
  if (!h.current()) return;
  const write = ["owner", "maintainer", "developer"].includes(r.role);
  const check = (name, label, checked = false) =>
    `<label class="check"><input type="checkbox" name="${name}" ${checked ? "checked" : ""}> ${label}</label>`;
  repoLayout(
    r,
    "forge",
    i18nHTML`<div class="panel"><div class="panelhead"><strong>${ephemeral ? i18nText("临时命名空间") : i18nText("主命名空间")}</strong><a class="btn small" data-link href="${esc(base + "/forge?ephemeral=" + !ephemeral)}">切换到${ephemeral ? i18nText("主") : i18nText("临时")}命名空间</a></div><div class="form"><code>${esc(r.clone_url.replace(".git", ephemeral ? "+ephemeral.git" : ".git"))}</code><p class="muted">${ephemeral ? i18nText("临时引用与主分支隔离；合并时选择临时来源即可保留成果。") : i18nText("Git push、API 编辑和合并使用统一的引用策略。")}</p></div></div><div class="forge-grid"><section class="panel"><div class="panelhead"><strong>分支 · ${branches.branches.length}</strong></div>${branches.branches.map((b) => `<div class="token-row"><div><strong>${esc(b.name)}</strong><p><code>${esc(b.sha.slice(0, 12))}</code></p></div>${write ? i18nHTML`<button class="btn small danger" data-branch="${esc(b.name)}" data-sha="${esc(b.sha)}">删除</button>` : ""}</div>`).join("")}${write ? i18nHTML`<form id="create-branch" class="form">${field(i18nText("新分支"), "target_branch")}${field(i18nText("起点分支、标签或 SHA"), "base_ref", "text", r.default_branch)}${check("base_is_ephemeral", i18nText("起点来自临时命名空间"), ephemeral)}<button class="btn primary" type="submit">创建分支</button></form>` : ""}</section><section class="panel"><div class="panelhead"><strong>标签 · ${tags.tags.length}</strong></div>${tags.tags.map((t) => `<div class="token-row"><strong>${esc(t.name)}</strong><code>${esc(t.sha.slice(0, 12))}</code>${write ? i18nHTML`<button class="btn small danger" data-tag="${esc(t.name)}">删除</button>` : ""}</div>`).join("")}${write ? i18nHTML`<form id="create-tag" class="form">${field(i18nText("标签名"), "tag-name")}${field(i18nText("起点"), "tag-ref", "text", r.default_branch)}<button class="btn primary" type="submit">创建标签</button></form>` : ""}</section></div><section class="panel"><form id="merge-preview" class="form"><h2>合并预览</h2><div class="forge-grid">${field(i18nText("来源分支 / SHA"), "source_ref")}${field(i18nText("目标分支"), "target_branch", "text", r.default_branch)}</div>${check("source_is_ephemeral", i18nText("来源为临时分支"), ephemeral)}${check("target_is_ephemeral", i18nText("目标为临时分支"))}<div class="field"><label>策略</label><select name="strategy"><option value="ff_prefer">优先快进，否则三方合并</option><option value="ff_only">仅快进</option><option value="merge">创建合并提交</option></select></div>${check("squash", i18nText("压缩为单个提交"))}<button class="btn" type="submit">预览变化</button><div id="merge-result"></div></form></section><div class="forge-grid"><section class="panel"><form class="form" id="note"><h2>Git Notes</h2>${field(i18nText("提交 SHA"), "sha")}${field(i18nText("Notes 引用"), "notes_ref", "text", "refs/notes/commits")}${textarea(i18nText("附注"), "note")}<div class="field"><label>操作</label><select name="operation"><option value="read">读取</option>${write ? i18nText('<option value="create">创建</option><option value="append">追加</option><option value="delete">删除</option>') : ""}</select></div><button class="btn" type="submit">执行</button><pre id="note-result" class="forge-output"></pre></form></section><section class="panel"><form id="download" class="form"><h2>文件与归档</h2>${field(i18nText("版本"), "ref", "text", r.default_branch)}<div class="field"><label>文件路径（留空下载归档）</label><input name="path"></div><button class="btn" type="submit">下载</button></form><form id="blame" class="form"><h2>逐行历史</h2>${field(i18nText("文件路径"), "path")}${field(i18nText("版本"), "ref", "text", r.default_branch)}<div class="field"><label>行范围（可选，例如 10,+5）</label><input name="range"></div><button class="btn" type="submit">查看 Blame</button><pre class="forge-output" id="blame-result"></pre></form></section></div>`,
  );
  const refresh = () => go(base + "/forge?ephemeral=" + ephemeral);
  if (write) {
    bindForm("#create-branch", async (d) => {
      await api(ap + "/branches/create", {
        method: "POST",
        body: { ...d, base_is_ephemeral: !!d.base_is_ephemeral, ephemeral },
      });
      refresh();
    });
    bindForm("#create-tag", async (d) => {
      await api(ap + "/tags", {
        method: "POST",
        body: { name: d["tag-name"], ref: d["tag-ref"], ephemeral },
      });
      refresh();
    });
    for (const b of document.querySelectorAll("[data-branch]"))
      b.onclick = async () => {
        try {
          if (!confirm(i18nText("删除分支 ") + b.dataset.branch + "？")) return;
          await api(ap + "/branches", {
            method: "DELETE",
            body: {
              branch: b.dataset.branch,
              expected_sha: b.dataset.sha,
              ephemeral,
            },
          });
          refresh();
        } catch (e) {
          notice(e.message);
        }
      };
    for (const b of document.querySelectorAll("[data-tag]"))
      b.onclick = async () => {
        try {
          await api(
            ap + "/tags/" + encodeURIComponent(b.dataset.tag) + suffix,
            { method: "DELETE" },
          );
          refresh();
        } catch (e) {
          notice(e.message);
        }
      };
  }
  bindForm("#merge-preview", async (d) => {
    const options = {
      source_ref: d.source_ref,
      target_branch: d.target_branch,
      source_is_ephemeral: !!d.source_is_ephemeral,
      target_is_ephemeral: !!d.target_is_ephemeral,
      include_content: true,
    };
    const preview = await api(
      ap + "/merge/preview?" + new URLSearchParams(options),
    );
    document.querySelector("#merge-result").innerHTML =
      i18nHTML`<div class="token-display"><strong>${preview.status === "clean" ? i18nText("可以合并") : i18nText("存在冲突")} · ${esc(preview.result)}</strong><p>目标：<code>${esc(preview.target_tip_sha)}</code></p>${preview.conflict_paths.length ? `<pre>${esc(preview.conflict_paths.join("\n"))}</pre>` : ""}${write && preview.status === "clean" ? i18nText('<button class="btn primary" type="button" id="apply-merge">合并此版本</button>') : ""}</div>`;
    document
      .querySelector("#apply-merge")
      ?.addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api(ap + "/merge", {
            method: "POST",
            body: {
              ...options,
              source_ref: preview.source_tip_sha,
              expected_target_sha: preview.target_tip_sha,
              strategy: d.strategy,
              squash: !!d.squash,
              commit_message:
                "Merge " + d.source_ref + " into " + d.target_branch,
            },
          });
          notice(i18nText("合并完成"));
          refresh();
        } catch (error) {
          notice(error.message);
        }
      });
  });
  bindForm("#note", async (d) => {
    let result;
    if (d.operation === "read")
      result = await api(
        ap +
          "/notes?" +
          new URLSearchParams({
            sha: d.sha,
            notes_ref: d.notes_ref,
            ephemeral,
          }),
      );
    else
      result = await api(ap + "/notes", {
        method: d.operation === "delete" ? "DELETE" : "POST",
        body: {
          ...d,
          operation: d.operation === "delete" ? undefined : d.operation,
          ephemeral,
        },
      });
    document.querySelector("#note-result").textContent =
      result.note ?? JSON.stringify(result, null, 2);
  });
  bindForm("#download", async (d) => {
    const response = await fetch(
      "/api" +
        ap +
        (d.path
          ? "/file?" + new URLSearchParams({ ...d, ephemeral })
          : "/archive?ephemeral=" + ephemeral),
      d.path
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ref: d.ref }),
          },
    );
    if (!response.ok) throw Error((await response.json()).error);
    const url = URL.createObjectURL(await response.blob()),
      a = document.createElement("a");
    a.href = url;
    a.download = d.path?.split("/").at(-1) || r.name + ".tar.gz";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  bindForm("#blame", async (d) => {
    const result = await api(
      ap + "/blame?" + new URLSearchParams({ ...d, ephemeral }),
    );
    document.querySelector("#blame-result").textContent = result.lines
      .map((l) => `${l.line}  ${l.sha.slice(0, 8)}  ${l.author}  ${l.content}`)
      .join("\n");
  });
}
