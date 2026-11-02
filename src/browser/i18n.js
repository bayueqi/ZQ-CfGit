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
if (typeof document !== "undefined") document.documentElement.lang = locale;
