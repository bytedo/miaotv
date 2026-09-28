export type SourceBrowserCategory = {
  type_id: string | number;
  type_name: string;
  type_pid?: string | number;
};

export function getDefaultSourceBrowserCategory(
  categories: SourceBrowserCategory[],
): string | number | undefined {
  let category = categories[0];
  const visited = new Set<string>();

  // Keep the first branch's meaning when the source only lists videos in leaves.
  while (category && !visited.has(String(category.type_id))) {
    visited.add(String(category.type_id));
    const child = categories.find(
      (candidate) =>
        candidate.type_pid != null &&
        String(candidate.type_pid) === String(category.type_id),
    );
    if (!child) return category.type_id;
    category = child;
  }

  // Flat or malformed category trees retain the source's original first entry.
  return categories[0]?.type_id;
}
