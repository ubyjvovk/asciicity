/**
 * Fetch-based loader for `CityData` (docs/architecture.md §4). Fetch the URL,
 * then validate the JSON payload.
 */
import type { CityData } from './types';
import { validateCity } from './validate';

/**
 * Fetch and validate city data from `url`, returning the validated `CityData`.
 * Throws `Error('city data: HTTP <status>')` on a non-OK response.
 */
export async function loadCity(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CityData> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`city data: HTTP ${res.status}`);
  }
  return validateCity(await res.json());
}
