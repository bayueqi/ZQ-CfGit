import {
  text as i18nText,
  html as i18nHTML,
  datetime as i18nTime,
} from "./i18n.js?v=421b50bfc6caff1b";
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
