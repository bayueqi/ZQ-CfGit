import errors from "./errors.json" with { type: "json" };
export function translateError(source, locale) {
  return locale === "zh-CN" && Object.hasOwn(errors, source)
    ? errors[source]
    : source;
}
// Only call this with application-owned literals, never user data or completed HTML.
export function translateLiteral(source) {
  return source;
}
export function translateTemplate(strings, values) {
  return strings
    .map((part, i) => part + (i < values.length ? String(values[i]) : ""))
    .join("");
}
