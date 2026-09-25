/**
 * PLATEAU data-catalog access with a file cache (T-0162 prototype, shared by
 * `fetch-cell.mjs` and the production converter `tokyo.mjs` since T-0163).
 *
 * - `/datacatalog/citygml/m:<mesh>` answers are cached as
 *   `<cache>/catalog/m_<mesh>.json`;
 * - mesh CityGML files (served gzip-encoded, ≈ 8:1; `fetch` decodes) as
 *   `<cache>/raw/<mesh>_bldg_<cityCode>_<year>.gml`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATACATALOG } from './citygml.mjs';

/**
 * GET JSON through a file cache.
 * @param {string} url
 * @param {string} file cache path
 * @returns {Promise<unknown>}
 */
export async function cachedJson(url, file) {
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const json = await res.json();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(json));
  return json;
}

/**
 * Every ward's building file for one mesh, latest year per ward:
 * `{ city, year, code, url, fileSize, features, lod0…lod4 }`, sorted by
 * features desc, then city code (deterministic).
 * @param {string} code 8-digit mesh code
 * @param {string} cache cache root (`.cache/plateau`)
 * @returns {Promise<object[]>}
 */
export async function meshFiles(code, cache) {
  const j = await cachedJson(`${DATACATALOG}/citygml/m:${code}`, join(cache, 'catalog', `m_${code}.json`));
  const latest = new Map();
  for (const c of j.cities ?? []) {
    const prev = latest.get(c.cityCode);
    if (!prev || Number(c.year) > Number(prev.year)) latest.set(c.cityCode, c);
  }
  const out = [];
  for (const c of latest.values()) {
    for (const f of c.files?.bldg ?? []) if (f.code === code) out.push({ city: c.cityCode, year: c.year, ...f });
  }
  return out.sort((a, b) => b.features - a.features || String(a.city).localeCompare(String(b.city)));
}

/**
 * The distinct copies of a mesh: a mesh on a ward boundary is published
 * whole by every ward (T-0162: byte-identical), so files with the same
 * `(features, fileSize)` are one copy — the first (largest, lowest ward code)
 * is kept. Files that differ are all read (the caller de-duplicates by gml:id).
 * @param {object[]} files `meshFiles` output
 * @returns {object[]}
 */
export function distinctCopies(files) {
  const seen = new Set();
  return files.filter((f) => {
    const k = `${f.features}|${f.fileSize}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Download (gzip transfer-decoded by fetch) and cache a mesh GML.
 * @param {object} file a `meshFiles` entry
 * @param {string} cache cache root
 * @param {(msg: string) => void} [log]
 * @returns {Promise<string>} path of the cached `.gml`
 */
export async function meshGml(file, cache, log = () => {}) {
  const path = join(cache, 'raw', `${file.code}_bldg_${file.city}_${file.year}.gml`);
  if (!existsSync(path)) {
    const t = Date.now();
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetch(file.url, { headers: { 'Accept-Encoding': 'gzip' } });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${file.url}`);
        const buf = Buffer.from(await res.arrayBuffer());
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(`${path}.tmp`, buf);
        renameSync(`${path}.tmp`, path); // never a partial file at `path`
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        log(`  retry ${file.code} (${file.city}) after: ${err instanceof Error ? err.message : err}`);
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
    log(`  downloaded ${file.code} (${file.city}) ${(file.fileSize / 1e6).toFixed(1)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
  return path;
}
