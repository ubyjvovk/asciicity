/**
 * Credits content: author/url plus the GNU Unifont attribution line for the
 * matrix katakana atlas (docs/architecture.md §4.20).
 */
import { describe, expect, it } from 'vitest';
import { CREDITS } from '../src/credits';

describe('CREDITS', () => {
  it('keeps the author and repo URL', () => {
    expect(CREDITS.author).toBe('@ubyjvovk');
    expect(CREDITS.url).toBe('https://github.com/ubyjvovk/asciicity');
  });

  it('includes a GNU Unifont attribution line', () => {
    expect(CREDITS.unifont).toMatch(/GNU Unifont/);
    expect(CREDITS.unifont).toMatch(/bitmap source/i);
    expect(CREDITS.unifont).toMatch(/SIL OFL 1\.1/);
    expect(CREDITS.unifont).toMatch(/GPL v2\+/);
    expect(CREDITS.unifont).toMatch(/font-embedding exception/);
  });
});
