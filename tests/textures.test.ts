/**
 * Unit tests for the pure parts of `src/world/textures.ts` — the running-bond
 * joint helpers of `makeStoneTexture` (architecture.md §4.23 "Facade"). The
 * canvas builders (`makeWindowTexture`, `makeStoneTexture`) are browser-only
 * and are covered by e2e, not unit tests.
 */
import { describe, expect, it } from 'vitest';
import { stoneCourseAt, stoneJointOffset } from '../src/world/textures';

describe('stoneCourseAt — course index for a pixel row (§4.23)', () => {
  it('row 0 is course 0; rows 0–31 are course 0', () => {
    expect(stoneCourseAt(0)).toBe(0);
    expect(stoneCourseAt(1)).toBe(0);
    expect(stoneCourseAt(31)).toBe(0);
  });

  it('course boundaries land exactly on multiples of 32', () => {
    expect(stoneCourseAt(32)).toBe(1);
    expect(stoneCourseAt(63)).toBe(1);
    expect(stoneCourseAt(64)).toBe(2);
  });

  it('full atlas is 8 courses (256 / 32)', () => {
    expect(stoneCourseAt(255)).toBe(7);
  });
});

describe('stoneJointOffset — 0 or 32 by course parity (§4.23 running bond)', () => {
  it('even courses have no offset', () => {
    expect(stoneJointOffset(0)).toBe(0);
    expect(stoneJointOffset(2)).toBe(0);
    expect(stoneJointOffset(6)).toBe(0);
  });

  it('odd courses stagger 32 px', () => {
    expect(stoneJointOffset(1)).toBe(32);
    expect(stoneJointOffset(3)).toBe(32);
    expect(stoneJointOffset(7)).toBe(32);
  });

  it('follows the course of a pixel row (32-px course height)', () => {
    for (let y = 0; y < 256; y++) {
      expect(stoneJointOffset(stoneCourseAt(y))).toBe(y % 64 < 32 ? 0 : 32);
    }
  });
});
