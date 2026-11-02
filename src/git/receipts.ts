/** DO put accepts at most 128 keys. Keep refs atomic even when a single Git
 * push changes many branches or tags. */
export async function putRefPublication(
  storage: DurableObjectStorage,
  values: Record<string, unknown>,
) {
  const entries = Object.entries(values);
  if (entries.length <= 128) return storage.put(values);
  await storage.transaction(async (txn) => {
    for (let offset = 0; offset < entries.length; offset += 128)
      await txn.put(Object.fromEntries(entries.slice(offset, offset + 128)));
  });
}
