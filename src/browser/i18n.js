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
if (typeof document !== "undefined") document.documentElement.lang = locale;
