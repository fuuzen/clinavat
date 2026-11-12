/** The rule that ignores exactly this path from the project root, as the server writes it. */
export function literalIgnore(path: string): string {
  return "/" + path.replace(/\/$/, "").replace(/[\\*?[\]]/g, (character) => `\\${character}`);
}

/** Groups paths by their parent directory ("" for the project root), largest groups first. */
export function groupByDirectory<T extends { path: string }>(items: T[]): { directory: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const slash = item.path.lastIndexOf("/");
    const directory = slash > 0 ? item.path.slice(0, slash) : "";
    groups.set(directory, [...(groups.get(directory) ?? []), item]);
  }
  return [...groups]
    .map(([directory, grouped]) => ({ directory, items: grouped }))
    .sort((left, right) => right.items.length - left.items.length || left.directory.localeCompare(right.directory));
}
