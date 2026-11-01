import {
  text as i18nText,
  html as i18nHTML,
  getLocale,
} from "./i18n.js?v=362799ab65ad23c5";
import { cachePanel } from "./ci-cache.js?v=053546286a152962";
import { variablePanel } from "./ci-variables.js?v=e433500c3c2c9b71";
const roleNames = {
  reader: i18nText("只读"),
  developer: i18nText("开发者"),
  maintainer: i18nText("维护者"),
  owner: i18nText("所有者"),
};
const statuses = {
  queued: i18nText("排队中"),
  running: i18nText("运行中"),
  succeeded: i18nText("成功"),
  failed: i18nText("失败"),
  canceled: i18nText("已取消"),
};
const button = (label, action, id = "", danger = false) =>
  `<button type="button" class="btn small ${danger ? "danger" : ""}" data-action="${action}" data-id="${id}">${label}</button>`;
function actions(h, callback) {
  document.querySelectorAll("[data-action]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        try {
          await callback(b.dataset.action, b.dataset.id, b);
        } catch (e) {
          h.notice(e.message);
        } finally {
          b.disabled = false;
        }
      }),
  );
}
const roleSelect = (owner = false) =>
  i18nHTML`<div class="field"><label>角色</label><select name="role">${Object.entries(
    roleNames,
  )
    .filter(([k]) => owner || k !== "owner")
    .map(([k, v]) => `<option value="${k}">${v}</option>`)
    .join("")}</select></div>`;
export async function ciPage(r, base, ap, h, runId) {
  const { api, repoLayout, esc, bindForm, field, textarea, render, go } = h,
    root = ap + "/ci",
    maintain = !r.archived_at && ["owner", "maintainer"].includes(r.role);
  if (runId) {
    const run = await api(root + "/runs/" + runId);
    if (!h.current()) return;
    const workflowJobs =
      run.config.runner === "workflow"
        ? run.config.jobs
            .map((job) => {
              const child = (run.jobs || []).find(
                (row) => row.job_key === job.id,
              );
              const state = child
                ? statuses[child.status]
                : ["failed", "canceled"].includes(run.status)
                  ? i18nText("未执行")
                  : i18nText("等待依赖");
              return `<div class="token-row"><div>${child ? `<a data-link href="${base}/ci/${child.id}"><strong>${esc(job.id)}</strong></a>` : `<strong>${esc(job.id)}</strong>`}<p class="muted">${esc(job.pipeline.runner)} · ${job.needs.length ? i18nText("依赖：") + job.needs.map(esc).join("、") : i18nText("可独立执行")}</p></div><span class="pill">${esc(state)}</span></div>`;
            })
            .join("")
        : "";
    repoLayout(
      r,
      "ci",
      i18nHTML`<div class="toolbar"><a data-link class="btn" href="${base}/ci">← 流水线</a><span class="pill ci-${run.status}">${statuses[run.status]}</span>${button(i18nText("刷新"), "refresh")}${maintain ? (["queued", "running"].includes(run.status) ? button(i18nText("取消运行"), "cancel", run.id, true) : !run.parent_id && !run.config_error ? button(i18nText("重新运行"), "retry", run.id) : "") : ""}</div>${run.parent_id ? i18nHTML`<p><a data-link href="${base}/ci/${run.parent_id}">← 返回工作流</a></p>` : ""}${workflowJobs ? i18nHTML`<section class="panel" aria-label="工作流任务"><div class="panelhead"><strong>任务与依赖</strong></div>${workflowJobs}</section>` : ""}<div class="panel"><div class="panelhead"><strong>${esc(run.config.name)}</strong><code>${run.sha.slice(0, 12)}</code></div><div class="detail-body"><p>${esc(run.ref)} · ${esc(run.trigger)} · ${esc(run.created_at)}</p>${run.config_path ? i18nHTML`<p>配置：<code>${esc(run.config_path)}</code> @ <code>${esc(run.config_sha?.slice(0, 12) || "")}</code></p>` : ""}${run.error ? `<p class="error">${esc(run.error)}</p>` : ""}<pre class="ci-log" aria-label="流水线日志">${esc(run.logs.map((l) => l.content).join("") || (run.config.runner === "workflow" ? i18nText("打开上方任务查看独立日志与产物。") : i18nText("等待执行器领取任务…")))}</pre></div></div><div class="panel"><div class="panelhead"><strong>构建产物</strong></div>${run.artifacts.map((a) => `<div class="token-row"><a href="/api${root}/runs/${run.id}/artifacts/${a.id}" download>${esc(a.name)}</a><span>${a.size} bytes</span></div>`).join("") || i18nText('<div class="empty">暂无产物</div>')}</div>`,
    );
    actions(h, async (a) => {
      if (a === "refresh") return render();
      const result = await api(root + "/runs/" + run.id + "/" + a, {
        method: "POST",
        body: {},
      });
      if (a === "retry") go(base + "/ci/" + result.id);
      else render();
    });
    if (["queued", "running"].includes(run.status))
      setTimeout(() => {
        if (h.current()) render();
      }, 5000);
    return;
  }
  const [
    saved,
    { runs },
    { schedules },
    runnerData,
    { variables, inherited = [] },
    cacheData,
  ] = await Promise.all([
    api(root + "/config"),
    api(root + "/runs"),
    api(root + "/schedules"),
    maintain ? api(root + "/runners") : Promise.resolve({ runners: [] }),
    maintain ? api(root + "/variables") : Promise.resolve({ variables: [] }),
    api(root + "/caches"),
  ]);
  if (!h.current()) return;
  const sample = {
    name: "构建并部署",
    runner: "external",
    branches: [r.default_branch],
    timeout_seconds: 900,
    steps: [
      { type: "run", name: "安装", command: "npm ci" },
      { type: "run", name: "测试", command: "npm test" },
      {
        type: "run",
        name: "部署到 Cloudflare",
        command: "npx wrangler deploy",
      },
    ],
    artifacts: [],
  };
  const cloudSample = {
    name: "Cloudflare JavaScript / WASM 应用",
    runner: "worker",
    branches: [r.default_branch],
    timeout_seconds: 90,
    steps: [
      {
        type: "javascript",
        entry: "ci.js",
        files: ["ci.js", "index.js"],
        cpu_ms: 1000,
      },
    ],
    deploy: {
      kind: "worker",
      entry: "index.js",
      files: ["index.js"],
      environment: "production",
    },
  };
  const buildSample = {
    name: "Cloudflare TypeScript / npm 构建",
    runner: "worker",
    branches: [r.default_branch],
    timeout_seconds: 110,
    steps: [
      {
        type: "build",
        entry: "src/index.ts",
        sources: ["src", "package.json", "package-lock.json"],
        outfile: "dist/index.js",
        platform: "worker",
      },
    ],
    deploy: {
      kind: "worker",
      entry: "dist/index.js",
      files: ["dist/index.js"],
      environment: "production",
    },
  };
  const workflowSample = {
    name: "并行检查与 Cloudflare 构建",
    runner: "workflow",
    branches: [r.default_branch],
    jobs: [
      {
        id: "source",
        pipeline: {
          runner: "worker",
          steps: [{ type: "file", path: "ci.js" }],
        },
      },
      {
        id: "metadata",
        pipeline: {
          runner: "worker",
          steps: [{ type: "file", path: "package.json", format: "json" }],
        },
      },
      { id: "build", needs: ["source", "metadata"], pipeline: cloudSample },
    ],
  };
  const config = saved.config || cloudSample;
  let editingSchedule = null;
  const variableUI = variablePanel(root, variables, r.default_branch, h, {
    inherited,
  });
  const schedulePanel = i18nHTML`<section class="panel" aria-label="定时流水线"><div class="panelhead"><strong>定时流水线</strong></div><div class="detail-body"><p class="muted">Cloudflare 每五分钟检查一次。延迟或停机期间错过的时间合并为一次运行。计划不受推送自动触发开关影响。</p>${schedules.map((s) => i18nHTML`<div class="token-row"><div><strong>${esc(s.name)}</strong> <span class="pill">${s.enabled ? i18nText("已启用") : i18nText("已暂停")}</span><p><code>${esc(s.cron)}</code> · ${esc(s.timezone)} · ${esc(s.ref)}</p><p class="muted">所有者 ${esc(s.owner)} · ${s.enabled ? i18nText("下次计划：") + esc(new Date(s.next_run_at).toLocaleString(undefined, { timeZone: s.timezone })) : i18nText("恢复后重新计算下次时间")}</p>${s.last_error ? `<p class="error">${esc(s.last_error)}</p>` : ""}${s.last_run_id ? i18nHTML`<a data-link href="${base}/ci/${s.last_run_id}">最近运行</a>` : ""}</div>${maintain ? `<div class="actionbar">${button(i18nText("编辑"), "schedule-edit", s.id)}${button(s.enabled ? i18nText("暂停") : i18nText("启用"), "schedule-toggle", s.id)}${button(i18nText("接管"), "schedule-own", s.id)}${button(i18nText("删除"), "schedule-delete", s.id, true)}</div>` : ""}</div>`).join("") || i18nText('<p class="empty">暂无定时流水线</p>')}</div>${maintain ? i18nHTML`<form class="form" id="schedule-config"><h3 id="schedule-form-title">新建计划</h3>${field(i18nText("名称"), "name")}${field(i18nText("分支"), "ref", "text", r.default_branch)}${field(i18nText("Cron（分 时 日 月 星期）"), "cron", "text", "0 9 * * 1-5")}${field(i18nText("IANA 时区"), "timezone", "text", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}<p class="hint">例如工作日 09:00：0 9 * * 1-5。星期 0/7 表示周日。每次运行固定分支当时的代码和配置。修改、暂停、接管或删除计划会取消其未完成运行。</p><label class="check"><input type="checkbox" name="enabled" checked> 启用计划</label><div class="actionbar"><button class="btn primary" type="submit">保存计划</button>${button(i18nText("清空编辑"), "schedule-reset")}</div></form>` : ""}</section>`;
  repoLayout(
    r,
    "ci",
    i18nHTML`<div class="titlebar"><div><h2>CI/CD</h2><p class="muted">推送自动触发，按提交构建，查看日志与部署结果。</p></div>${button(i18nText("刷新"), "refresh")}</div>${maintain ? i18nHTML`<form class="toolbar" id="run-pipeline">${field(i18nText("分支"), "ref", "text", r.default_branch)}<button class="btn primary" type="submit">运行流水线</button></form>` : ""}<div class="panel"><div class="panelhead"><strong>最近运行</strong><span>${saved.enabled ? i18nText("自动触发已启用") : i18nText("自动触发已关闭")}</span></div>${runs.map((run) => `<div class="token-row"><div><a data-link href="${base}/ci/${run.id}"><strong>${esc(run.config.name)}</strong></a><p class="muted">${esc(run.ref)} · ${run.sha.slice(0, 8)} · ${esc(run.created_at)}</p></div><span class="pill ci-${run.status}">${statuses[run.status]}</span></div>`).join("") || i18nText('<div class="empty">配置流水线后，推送代码或手动运行。</div>')}</div>${schedulePanel}${cachePanel(cacheData, base, maintain, esc)}${maintain ? variableUI.html : ""}${maintain ? i18nHTML`<div class="panel"><form class="form" id="pipeline-config"><h2>流水线配置</h2><p class="muted">TypeScript/npm 模板直接编译 src 入口，npm 依赖须提交 package-lock.json，不执行 npm 脚本。私有 npm 模板需要在上方创建 PACKAGE_TOKEN 密钥，填入具有包读取权限的部署令牌；模板默认使用本项目包仓库，跨项目时请修改 project_id。JavaScript/WASM 模板运行导出异步函数的 ci.js，失败时抛出异常。构建完成后在「应用发布」中激活或回滚。</p><div class="actionbar">${button(i18nText("TypeScript / npm 云端构建"), "template-build")}${button(i18nText("私有 npm 云端构建"), "template-private-build")}${button(i18nText("工作流模板"), "template-workflow")}${button(i18nText("Cloudflare 云端执行模板"), "template-cloud")}${button(i18nText("外部 Runner 模板"), "template-external")}${button(i18nText("Worker 检查模板"), "template-worker")}</div><label>配置来源<select name="source_mode"><option value="inline" ${saved.source_path ? "" : "selected"}>页面保存的配置</option><option value="repository" ${saved.source_path ? "selected" : ""}>仓库中的 JSON 文件</option></select></label><label data-ci-source="repository">配置文件路径<input name="source_path" value="${esc(saved.source_path || ".zq-cfgit-ci.json")}"></label><p class="hint">仓库配置随提交固定；MR 使用目标提交的配置，重试保留原始配置快照。修复无效配置后请新建运行。</p><div data-ci-source="inline">${textarea(i18nText("JSON 配置"), "config", JSON.stringify(config, null, 2), "code-input")}</div><label class="check"><input type="checkbox" name="enabled" ${saved.enabled ? "checked" : ""}> 推送自动触发</label><button class="btn primary" type="submit">保存配置</button></form></div><div class="panel"><div class="panelhead"><strong>仓库 Runner</strong></div>${runnerData.runners.map((r) => `<div class="token-row"><div><strong>${esc(r.name)}</strong><p class="muted">${r.last_seen ? i18nText("最近在线 ") + new Date(r.last_seen).toLocaleString(getLocale()) : i18nText("尚未连接")}</p></div>${button(i18nText("撤销"), "revoke-runner", r.id, true)}</div>`).join("")}<form class="form" id="create-runner">${field(i18nText("Runner 名称"), "name")}<button class="btn" type="submit">注册 Runner</button></form><div id="runner-token"></div><div class="detail-body"><p>在专用主机下载源码、安装依赖后运行：</p><pre>ZQCFGIT_ORIGIN=${esc(location.origin)} \\\nZQCFGIT_RUNNER_TOKEN_FILE=/secure/runner-token \\\nZQCFGIT_JOB_ENV=CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID \\\nnode scripts/runner.mjs</pre><p class="muted">令牌文件权限设为 600。仅连接你信任代码的仓库；每个 Runner 只领取本仓库任务。</p></div></div>` : ""}`,
  );
  if (maintain) variableUI.bind();
  bindForm("#run-pipeline", async (b) => {
    const run = await api(root + "/runs", { method: "POST", body: b });
    go(base + "/ci/" + run.id);
  });
  bindForm("#schedule-config", async (b) => {
    await api(
      root + "/schedules" + (editingSchedule ? "/" + editingSchedule.id : ""),
      {
        method: editingSchedule ? "PUT" : "POST",
        body: {
          ...b,
          enabled: b.enabled === "on",
          ...(editingSchedule ? { revision: editingSchedule.revision } : {}),
        },
      },
    );
    render();
  });
  bindForm("#pipeline-config", async (b) => {
    await api(root + "/config", {
      method: "PUT",
      body: {
        ...(b.source_mode === "repository"
          ? { source_path: b.source_path }
          : { config: JSON.parse(b.config) }),
        enabled: b.enabled === "on",
      },
    });
    render();
  });
  const mode = document.querySelector(
    '#pipeline-config select[name="source_mode"]',
  );
  if (mode) {
    const updateMode = () =>
      document.querySelectorAll("[data-ci-source]").forEach((element) => {
        element.hidden = element.dataset.ciSource !== mode.value;
      });
    mode.onchange = updateMode;
    updateMode();
  }
  bindForm("#create-runner", async (b) => {
    const runner = await api(root + "/runners", { method: "POST", body: b });
    document.querySelector("#runner-token").innerHTML =
      i18nHTML`<div class="detail-body"><strong>令牌仅显示这一次，请保存到 Runner 的令牌文件</strong><pre>${esc(runner.token)}</pre></div>`;
  });
  actions(h, async (a, id) => {
    if (a === "refresh") return render();
    if (a === "cache-clear") {
      await api(root + "/caches/clear", {
        method: "POST",
        body: { generation: cacheData.generation },
      });
      return render();
    }
    if (a.startsWith("variable-")) return variableUI.action(a, id);
    if (a.startsWith("schedule-")) {
      const s = schedules.find((s) => s.id === id),
        form = document.querySelector("#schedule-config");
      if (a === "schedule-edit" || a === "schedule-reset") {
        editingSchedule = a === "schedule-edit" ? s : null;
        form.reset();
        if (editingSchedule) {
          for (const k of ["name", "ref", "cron", "timezone"])
            form.elements[k].value = s[k];
          form.elements.enabled.checked = !!s.enabled;
        }
        document.querySelector("#schedule-form-title").textContent =
          editingSchedule ? i18nText("编辑计划") : i18nText("新建计划");
        form.scrollIntoView({ block: "nearest" });
        return;
      }
      if (!s) return;
      const path = root + "/schedules/" + s.id;
      if (a === "schedule-delete")
        await api(path, { method: "DELETE", body: { revision: s.revision } });
      if (a === "schedule-own")
        await api(path + "/take-ownership", {
          method: "POST",
          body: { revision: s.revision },
        });
      if (a === "schedule-toggle")
        await api(path, {
          method: "PUT",
          body: {
            name: s.name,
            ref: s.ref,
            cron: s.cron,
            timezone: s.timezone,
            enabled: !s.enabled,
            revision: s.revision,
          },
        });
      return render();
    }
    if (a === "revoke-runner") {
      await api(root + "/runners/" + id, { method: "DELETE" });
      return render();
    }
    if (a.startsWith("template-")) {
      if (mode) {
        mode.value = "inline";
        mode.onchange();
      }
      document.querySelector("#pipeline-config textarea").value =
        JSON.stringify(
          a === "template-private-build"
            ? {
                ...buildSample,
                name: "私有 npm 云端构建",
                variables: ["PACKAGE_TOKEN"],
                steps: buildSample.steps.map((s) => ({
                  ...s,
                  private_registries: [
                    { project_id: r.id, token_variable: "PACKAGE_TOKEN" },
                  ],
                })),
              }
            : a === "template-build"
              ? buildSample
              : a === "template-workflow"
                ? workflowSample
                : a === "template-cloud"
                  ? cloudSample
                  : a === "template-worker"
                    ? {
                        name: "仓库检查",
                        runner: "worker",
                        branches: [r.default_branch],
                        steps: [
                          {
                            type: "file",
                            path: "package.json",
                            format: "json",
                          },
                        ],
                        artifacts: [],
                      }
                    : sample,
          null,
          2,
        );
    }
  });
}
