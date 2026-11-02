import {
  text as i18nText,
  html as i18nHTML,
} from "./i18n.js?v=575ef2cba56d5e2e";
export async function forgePage(r, base, ap, h) {
  const { api, repoLayout, esc, field, bindForm, notice, go } = h;
  const [branches, tags] = await Promise.all([
    api(ap + "/branches"),
    api(ap + "/tags"),
  ]);
  if (!h.current()) return;
  const write = ["owner", "maintainer", "developer"].includes(r.role);
  repoLayout(
    r,
    "forge",
    i18nHTML`<div class="forge-grid"><section class="panel"><div class="panelhead"><strong>分支 · ${branches.branches.length}</strong></div>${branches.branches.map((b) => `<div class="token-row"><div><strong>${esc(b.name)}</strong><p><code>${esc(b.sha.slice(0, 12))}</code></p></div>${write ? i18nHTML`<button class="btn small danger" data-branch="${esc(b.name)}" data-sha="${esc(b.sha)}">删除</button>` : ""}</div>`).join("")}${write ? i18nHTML`<form id="create-branch" class="form">${field(i18nText("新分支"), "target_branch")}${field(i18nText("起点分支、标签或 SHA"), "base_ref", "text", r.default_branch)}<button class="btn primary" type="submit">创建分支</button></form>` : ""}</section><section class="panel"><div class="panelhead"><strong>标签 · ${tags.tags.length}</strong></div>${tags.tags.map((t) => `<div class="token-row"><strong>${esc(t.name)}</strong><code>${esc(t.sha.slice(0, 12))}</code>${write ? i18nHTML`<button class="btn small danger" data-tag="${esc(t.name)}">删除</button>` : ""}</div>`).join("")}${write ? i18nHTML`<form id="create-tag" class="form">${field(i18nText("标签名"), "tag-name")}${field(i18nText("起点"), "tag-ref", "text", r.default_branch)}<button class="btn primary" type="submit">创建标签</button></form>` : ""}</section></div><section class="panel"><form id="download" class="form"><h2>文件与归档</h2>${field(i18nText("版本"), "ref", "text", r.default_branch)}<div class="field"><label>文件路径（留空下载归档）</label><input name="path"></div><button class="btn" type="submit">下载</button></form></section>`,
  );
  const refresh = () => go(base + "/forge");
  if (write) {
    bindForm("#create-branch", async (d) => {
      await api(ap + "/branches/create", {
        method: "POST",
        body: { target_branch: d.target_branch, base_ref: d.base_ref },
      });
      refresh();
    });
    bindForm("#create-tag", async (d) => {
      await api(ap + "/tags", {
        method: "POST",
        body: { name: d["tag-name"], ref: d["tag-ref"] },
      });
      refresh();
    });
    for (const b of document.querySelectorAll("[data-branch]"))
      b.onclick = async () => {
        try {
          if (!confirm(i18nText("删除分支 ") + b.dataset.branch + "？")) return;
          await api(ap + "/branches", {
            method: "DELETE",
            body: { branch: b.dataset.branch, expected_sha: b.dataset.sha },
          });
          refresh();
        } catch (e) {
          notice(e.message);
        }
      };
    for (const b of document.querySelectorAll("[data-tag]"))
      b.onclick = async () => {
        try {
          await api(ap + "/tags/" + encodeURIComponent(b.dataset.tag), {
            method: "DELETE",
          });
          refresh();
        } catch (e) {
          notice(e.message);
        }
      };
  }
  bindForm("#download", async (d) => {
    const response = await fetch(
      "/api" +
        ap +
        (d.path
          ? "/file?" + new URLSearchParams({ ref: d.ref, path: d.path })
          : "/archive"),
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
}
