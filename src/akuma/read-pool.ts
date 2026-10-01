export const PAGE_POOL_SIZE = 16;

export async function boundedMap<Value, Result>(
  values: readonly Value[],
  mapper: (value: Value) => Promise<Result>,
): Promise<readonly Result[]> {
  const results: Result[] = [];
  let index = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const selected = index++;
      if (selected >= values.length) return;
      results[selected] = await mapper(values[selected]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_POOL_SIZE, values.length) }, worker));
  return results;
}
