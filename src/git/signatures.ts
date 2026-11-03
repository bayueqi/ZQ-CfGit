import { fail } from "../security";
export { base64 } from "../base64";
export function unbase64(value: string) {
  // atob validates the alphabet and padding itself; a regex over multi-megabyte
  // strings overflows the stack in workerd.
  // base64 膨胀 4/3，上限按最大对象（24 MiB）换算后再留余量。
  if (value.length > 36 * 1024 * 1024) fail(400, "Invalid base64");
  let bin: string;
  try {
    bin = atob(value);
  } catch {
    fail(400, "Invalid base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
