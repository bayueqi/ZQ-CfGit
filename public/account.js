import {
  text as i18nText,
  html as i18nHTML,
  action as i18nAction,
  datetime as i18nTime,
  visibility as i18nVisibility,
} from "./i18n.js?v=3c48eba548be8390";
function bindActions(h, fn) {
  document.querySelectorAll("[data-session]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await fn(b.dataset.session);
        } catch (e) {
          h.notice(e.message);
        } finally {
          b.disabled = false;
        }
      }),
  );
}
export async function securityPage(h) {
  const { api, layout, render } = h,
    { sessions } = await api("/account/sessions");
  if (!h.current()) return;
  layout(
    i18nHTML`<div class="titlebar"><div><h1>账户安全</h1><p>查看和撤销浏览器会话。</p></div></div><section class="panel"><div class="panelhead"><h2>浏览器会话</h2></div>${sessions.map((s) => i18nHTML`<div class="token-row"><div><strong>${s.current ? i18nText("当前会话") : i18nText("其他会话")}</strong><p>${i18nTime(s.created_at)} · 到期 ${i18nTime(new Date(s.expires_at).toISOString())}</p></div><button class="btn small" type="button" data-session="${s.id}">${s.current ? i18nText("退出当前会话") : i18nText("撤销")}</button></div>`).join("")}</section>`,
    i18nText("账户安全"),
    "account",
  );
  bindActions(h, async (id) => {
    await api("/account/sessions/" + id, { method: "DELETE" });
    if (sessions.find((x) => x.id === id).current) location.assign("/login");
    else render();
  });
}
export async function profilePage(h, name) {
  const { api, layout, esc, icon } = h,
    q = new URLSearchParams(location.search),
    d = await api(
      "/profiles/" +
        encodeURIComponent(name) +
        (q.get("before")
          ? "?before=" + encodeURIComponent(q.get("before"))
          : ""),
    );
  if (!h.current()) return;
  const p = d.profile,
    detail = (a) => {
      const v = (a.detail || "").trim();
      if (!v || v === "{}" || v.startsWith("{")) return "";
      return a.action === "repo.update" ? i18nVisibility(v) : v;
    },
    repoRow = (r) => `<div class="repo-row"><div class="repo-icon">${icon("repo")}</div><div class="repo-info"><a data-link class="repo-name" href="/${esc(r.namespace)}/${encodeURIComponent(r.name)}"><span class="namespace">${esc(r.namespace)} / </span>${esc(r.name)}</a><p>${esc(r.description || i18nText("这个项目还没有描述。"))}</p></div><span class="pill">${esc(i18nVisibility(r.visibility))}</span></div>`,
    activityRow = (a) => `<div class="token-row"><div><a data-link href="/${esc(a.namespace)}/${encodeURIComponent(a.name)}">${esc(a.namespace)}/${esc(a.name)}</a><p>${esc(i18nAction(a.action))}${detail(a) ? " · " + esc(detail(a)) : ""}</p></div><span>${i18nTime(a.created_at)}</span></div>`;
  layout(
    i18nHTML`<div class="titlebar"><div><h1>${esc(p.username)}</h1><p class="muted">${i18nTime(p.created_at)} 已加入</p></div></div><section class="panel"><div class="panelhead"><strong>项目</strong><span class="muted">${d.repositories.length} 个</span></div>${d.repositories.map(repoRow).join("") || `<div class="empty"><p>${i18nText("暂无可见项目")}</p></div>`}</section><section class="panel"><div class="panelhead"><strong>活动</strong><span class="muted">最近 ${d.activity.length} 条</span></div>${d.activity.map(activityRow).join("") || `<div class="empty"><p>${i18nText("暂无可见活动")}</p></div>`}${d.next ? i18nHTML`<div class="token-row"><a data-link class="btn small" href="/profile?user=${esc(name)}&before=${d.next}">更早的活动</a></div>` : ""}</section>`,
    i18nText("我的动态"),
    "profile",
  );
}
