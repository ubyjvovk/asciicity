/**
 * Loading indicator (docs/architecture.md §4.18). Pure `formatLoading` for
 * the start-overlay `<p>` plus a streaming `loadCityJson` that reports
 * `download → parse → ready` while the dataset is fetched. `main.ts` drives
 * the `build` phase between the major builders. No DOM, no three.js.
 */

/** Loading phases exposed on `window.__asciicity.loading`. */
export interface LoadProgress {
  /** Which stage of the boot is running. `ready` clears the overlay text. */
  phase: 'download' | 'parse' | 'build' | 'ready';
  /** Bytes received so far (clamped to `total`). */
  received: number;
  /** Denominator for the progress bar (Content-Length or `sizeHint`). */
  total: number;
  /** Upper-case name of the builder currently running (`build` only). */
  step?: string;
}

/** Width of the ASCII progress bar (cells). */
const BAR_CELLS = 20;

/** Bytes per megabyte for the `x.x MB` readout (matches the SF `14.7 MB` spec). */
const MB = 1_000_000;

/**
 * Render the overlay `<p>` text for a given phase. `download` shows a 20-cell
 * ASCII bar with MB counters (one decimal); `parse`/`build` are one-line
 * banners; `ready` returns the empty string so the overlay's usual prompt
 * takes over. Pure — safe to call on every progress tick.
 */
export function formatLoading(label: string, p: LoadProgress): string {
  const upper = label.toUpperCase();
  if (p.phase === 'ready') return '';
  if (p.phase === 'parse') return `PARSING ${upper}`;
  if (p.phase === 'build') {
    return p.step ? `BUILDING ${upper} · ${p.step}` : `BUILDING ${upper}`;
  }
  // Integer math for `filled` and `pct` — `6_027_000 / 14_700_000 * 100` in
  // float rounds to 40.9999… so `Math.floor(ratio * 100)` would print 40 %
  // for a value the spec (§4.18) reads as 41 %.
  const total = Math.max(1, p.total);
  const received = Math.max(0, Math.min(p.received, p.total));
  const filled = Math.floor((received * BAR_CELLS) / total);
  const bar = '#'.repeat(filled) + '.'.repeat(BAR_CELLS - filled);
  const pct = Math.floor((received * 100) / total);
  const recMb = (received / MB).toFixed(1);
  const totMb = (p.total / MB).toFixed(1);
  return `LOADING ${upper}\n[${bar}] ${pct}% · ${recMb} / ${totMb} MB`;
}

/**
 * Fetch a city JSON with streaming progress. `total` is `Content-Length`
 * when the response has no `content-encoding` header, otherwise `sizeHint`;
 * `received` is clamped to `total`. Throws `Error('city data: HTTP <status>')`
 * on a non-OK response (same shape as `loadCity`).
 */
export async function loadCityJson(
  url: string,
  sizeHint: number,
  onProgress: (p: LoadProgress) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`city data: HTTP ${res.status}`);
  }
  const encoding = res.headers.get('content-encoding');
  const contentLength = res.headers.get('content-length');
  const parsedLen = contentLength !== null ? Number(contentLength) : NaN;
  const total = encoding === null && Number.isFinite(parsedLen) && parsedLen > 0
    ? parsedLen
    : sizeHint;

  onProgress({ phase: 'download', received: 0, total });

  const body = res.body;
  if (body === null) {
    const text = await res.text();
    onProgress({ phase: 'download', received: total, total });
    onProgress({ phase: 'parse', received: total, total });
    return JSON.parse(text);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received = Math.min(received + value.length, total);
      onProgress({ phase: 'download', received, total });
    }
  }

  onProgress({ phase: 'parse', received: total, total });

  let byteLength = 0;
  for (const c of chunks) byteLength += c.length;
  const merged = new Uint8Array(byteLength);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  const text = new TextDecoder('utf-8').decode(merged);
  return JSON.parse(text);
}
