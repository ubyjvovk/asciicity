/**
 * Unit tests for `src/ui/loading.ts` — the pure `formatLoading` phase renderer
 * and the streaming `loadCityJson` against a stubbed `fetch`. Covers each
 * phase, the `received > total` clamp, and Content-Length vs gzip.
 */
import { describe, expect, it } from 'vitest';
import { formatLoading, loadCityJson, type LoadProgress } from '../src/ui/loading';

const SF_TOTAL = 14_700_000;

describe('formatLoading', () => {
  it("download at 0 % → 'LOADING SAN FRANCISCO\\n[....................] 0% · 0.0 / 14.7 MB'", () => {
    const p: LoadProgress = { phase: 'download', received: 0, total: SF_TOTAL };
    expect(formatLoading('San Francisco', p)).toBe(
      'LOADING SAN FRANCISCO\n[....................] 0% · 0.0 / 14.7 MB',
    );
  });

  it("download at 41 % → '[########............] 41% · 6.0 / 14.7 MB'", () => {
    const p: LoadProgress = {
      phase: 'download',
      received: Math.round(SF_TOTAL * 0.41),
      total: SF_TOTAL,
    };
    expect(formatLoading('San Francisco', p)).toBe(
      'LOADING SAN FRANCISCO\n[########............] 41% · 6.0 / 14.7 MB',
    );
  });

  it("download at 100 % → '[####################] 100% · 14.7 / 14.7 MB'", () => {
    const p: LoadProgress = { phase: 'download', received: SF_TOTAL, total: SF_TOTAL };
    expect(formatLoading('San Francisco', p)).toBe(
      'LOADING SAN FRANCISCO\n[####################] 100% · 14.7 / 14.7 MB',
    );
  });

  it("parse → 'PARSING SAN FRANCISCO'", () => {
    const p: LoadProgress = { phase: 'parse', received: SF_TOTAL, total: SF_TOTAL };
    expect(formatLoading('San Francisco', p)).toBe('PARSING SAN FRANCISCO');
  });

  it("build with a step → 'BUILDING SAN FRANCISCO · TREES'", () => {
    const p: LoadProgress = { phase: 'build', received: 0, total: 0, step: 'TREES' };
    expect(formatLoading('San Francisco', p)).toBe('BUILDING SAN FRANCISCO · TREES');
  });

  it('tiled-boot loading phase sequence via formatLoading fixtures (TILE steps)', () => {
    const label = 'San Francisco';
    const seq: LoadProgress[] = [
      { phase: 'download', received: 0, total: 1_273_711 },
      { phase: 'parse', received: 1_273_711, total: 1_273_711 },
      { phase: 'build', received: 0, total: 400_000, step: 'TERRAIN' },
      { phase: 'build', received: 0, total: 400_000, step: 'WATER' },
      { phase: 'build', received: 80_000, total: 400_000, step: 'TILE -7_-3' },
      { phase: 'build', received: 180_000, total: 400_000, step: 'TILE -7_-2' },
      { phase: 'build', received: 400_000, total: 400_000, step: 'TILE -6_-3' },
      { phase: 'ready', received: 400_000, total: 400_000 },
    ];
    expect(seq.map((p) => formatLoading(label, p))).toEqual([
      'LOADING SAN FRANCISCO\n[....................] 0% · 0.0 / 1.3 MB',
      'PARSING SAN FRANCISCO',
      'BUILDING SAN FRANCISCO · TERRAIN',
      'BUILDING SAN FRANCISCO · WATER',
      'BUILDING SAN FRANCISCO · TILE -7_-3',
      'BUILDING SAN FRANCISCO · TILE -7_-2',
      'BUILDING SAN FRANCISCO · TILE -6_-3',
      '',
    ]);
  });

  it("ready → ''", () => {
    const p: LoadProgress = { phase: 'ready', received: SF_TOTAL, total: SF_TOTAL };
    expect(formatLoading('San Francisco', p)).toBe('');
  });

  it('received > total clamps to 100 %', () => {
    const p: LoadProgress = {
      phase: 'download',
      received: SF_TOTAL * 2,
      total: SF_TOTAL,
    };
    expect(formatLoading('San Francisco', p)).toBe(
      'LOADING SAN FRANCISCO\n[####################] 100% · 14.7 / 14.7 MB',
    );
  });
});

/**
 * Build a stubbed `fetch` that returns a body with three chunks and the given
 * headers. The `Content-Length` is set from `bodyBytes.length` unless
 * overridden. `contentEncoding` is set literally when non-null.
 */
function stubFetch(
  bodyBytes: Uint8Array,
  chunks: number,
  headers: { contentEncoding?: string | null; contentLength?: string } = {},
): typeof fetch {
  const size = Math.ceil(bodyBytes.length / chunks);
  const hdrs = new Headers();
  hdrs.set(
    'content-length',
    headers.contentLength ?? String(bodyBytes.length),
  );
  if (headers.contentEncoding !== undefined && headers.contentEncoding !== null) {
    hdrs.set('content-encoding', headers.contentEncoding);
  }
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bodyBytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + size, bodyBytes.length);
      controller.enqueue(bodyBytes.slice(offset, end));
      offset = end;
    },
  });
  const response = new Response(body, { status: 200, headers: hdrs });
  return (async () => response) as unknown as typeof fetch;
}

describe('loadCityJson', () => {
  it('reports monotonically increasing received and returns the parsed JSON (no content-encoding, Content-Length set)', async () => {
    const payload = { hello: 'world', n: 42 };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const events: LoadProgress[] = [];
    const parsed = await loadCityJson(
      'http://x/city.json',
      99_999_999,
      (p) => events.push({ ...p }),
      stubFetch(bytes, 3),
    );
    expect(parsed).toEqual(payload);
    // total picks up Content-Length (bytes.length), not sizeHint.
    for (const ev of events) expect(ev.total).toBe(bytes.length);
    const downloads = events.filter((e) => e.phase === 'download');
    // Initial 0-byte tick + three chunks + the final clamp = at least the
    // three chunks; assert strict monotonicity across the tail.
    for (let i = 1; i < downloads.length; i++) {
      expect(downloads[i].received).toBeGreaterThanOrEqual(downloads[i - 1].received);
    }
    expect(downloads[downloads.length - 1].received).toBe(bytes.length);
    // Followed by a `parse` tick before the promise resolves.
    expect(events[events.length - 1].phase).toBe('parse');
  });

  it('uses sizeHint as total when content-encoding is gzip', async () => {
    const payload = { g: 'z' };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const events: LoadProgress[] = [];
    const sizeHint = 12_345;
    const parsed = await loadCityJson(
      'http://x/city.json',
      sizeHint,
      (p) => events.push({ ...p }),
      stubFetch(bytes, 2, { contentEncoding: 'gzip' }),
    );
    expect(parsed).toEqual(payload);
    for (const ev of events) expect(ev.total).toBe(sizeHint);
    // Received is clamped: bytes.length < sizeHint so nothing to clamp.
    expect(events[events.length - 1].phase).toBe('parse');
  });

  it("throws 'city data: HTTP <status>' on a non-OK response", async () => {
    const fake = (async () => new Response('bad', { status: 500 })) as unknown as typeof fetch;
    await expect(loadCityJson('http://x/city.json', 1, () => undefined, fake)).rejects.toThrow(
      'city data: HTTP 500',
    );
  });
});
