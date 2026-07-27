/**
 * Folds a place name to a comparison key: width, case, spacing and the
 * 臺/台 variants all differ freely between OSM, Google and our own data for
 * the same place. Shared so every de-duplication step compares the same way.
 *
 * @param name The display name.
 * @returns The normalized key.
 */
export function normalizePlaceName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/臺/g, "台")
    .toLowerCase();
}
