export function groupItems(items: { name: string }[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  }
  return Array.from(counts, ([name, count]) => ({ name, count }));
}