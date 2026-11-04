/** EU member states (ISO 3166-1 alpha-2). */
export const EU_COUNTRIES = [
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE",
] as const;

/** Region groups usable in a model licence's territory exclusions. */
const GROUPS: Record<string, readonly string[]> = { EU: EU_COUNTRIES };

/** True when the ISO country code falls inside any excluded country or group. */
export function isRegionExcluded(country: string, exclusions: readonly string[]): boolean {
  const c = country.toUpperCase();
  return exclusions.some((x) => x.toUpperCase() === c || (GROUPS[x.toUpperCase()]?.includes(c) ?? false));
}
