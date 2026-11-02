import { fail } from "../security";
export { base64 } from "../base64";
export function unbase64(value: string) {
  if (
    value.length > 24 * 1024 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    fail(400, "Invalid base64");
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
