import { relativeTime as formatRelativeTime } from "../i18n/relative.ts";
import {
  translateLiteral,
  translateTemplate,
  translateError,
} from "../i18n/core.js";
const locale = "zh-CN";
export const getLocale = () => locale;
export const relativeTime = (value) => formatRelativeTime(value, locale);
export const text = (source) => translateLiteral(source, locale);
export const errorText = (source) => translateError(source, locale);
export const html = (strings, ...values) =>
  translateTemplate(strings, values, locale);
const stateNames = {
  open: "开放",
  closed: "已关闭",
  merged: "已合并",
  draft: "草稿",
  active: "已启用",
  inactive: "已停用",
  pending: "等待中",
  queued: "排队中",
  running: "运行中",
  succeeded: "成功",
  success: "成功",
  failed: "失败",
  canceled: "已取消",
  revoked: "已撤销",
  expired: "已过期",
  delivered: "已投递",
};
export const state = (value) => stateNames[value] || value;
const actionNames = {
  "repo.create": "创建项目",
  "repo.update": "更新项目设置",
  "repo.delete": "删除项目",
  "repo.commit": "网页提交",
  "repo.credential.update": "更新部署凭据",
  "repo.credential.delete": "删除部署凭据",
  "repo.upstream.update": "更新上游同步",
  "git.receive_pack": "推送代码",
  "git.push": "推送代码",
  "git.tag.delete": "删除标签",
  "issue.create": "新建议题",
  "issue.update": "更新议题",
  "issue.close": "关闭议题",
  "issue.comment": "评论议题",
  "merge.create": "发起合并请求",
  "merge.update": "更新合并请求",
  "merge.merge": "合并请求",
  "wiki.update": "更新维基",
  "ci.config.update": "更新 CI 配置",
  "ci.run.create": "触发构建",
  "ci.run.cancel": "取消构建",
  "ci.run.retry": "重试构建",
  "ci.runner.create": "新增 Runner",
  "ci.runner.revoke": "撤销 Runner",
  "ci.schedule.create": "新建定时任务",
  "ci.schedule.update": "更新定时任务",
  "ci.schedule.delete": "删除定时任务",
  "deployment.activate": "启用应用发布",
  "protection.update": "更新分支保护",
  "protection.delete": "删除分支保护",
  "release.create": "发布版本",
  "release.delete": "删除版本",
  "token.create": "生成访问令牌",
  "semantic.settings": "更新语义搜索设置",
  "semantic.rebuild": "重建代码索引",
};
export const action = (value) => actionNames[value] || value;
export const visibility = (value) =>
  value === "public" ? "公开" : value === "private" ? "私有" : value || "私有";
if (typeof document !== "undefined") document.documentElement.lang = locale;
