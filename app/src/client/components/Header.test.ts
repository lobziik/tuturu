/**
 * Unit tests for {@link pickBadge}.
 *
 * The badge is the only security indicator the user ever sees, so the matrix
 * over (e2eeMediaEnabled, sfuMode) is worth pinning explicitly.
 *
 * @module client/components/Header.test
 */

import { describe, test, expect } from 'bun:test';
import { pickBadge } from './Header';

describe('pickBadge', () => {
  test('E2EE on + mesh → "E2EE" badge (not off)', () => {
    expect(pickBadge(true, false)).toEqual({
      label: 'E2EE',
      title: 'Media is end-to-end encrypted',
      off: false,
    });
  });

  test('E2EE on + SFU → "E2EE" badge (E2EE wins, topology irrelevant)', () => {
    expect(pickBadge(true, true)).toEqual({
      label: 'E2EE',
      title: 'Media is end-to-end encrypted',
      off: false,
    });
  });

  test('E2EE off + SFU → "SFU · server can see media" warn badge', () => {
    const badge = pickBadge(false, true);
    expect(badge).not.toBeNull();
    expect(badge!.label).toBe('SFU · server can see media');
    expect(badge!.off).toBe(true);
    expect(badge!.title).toMatch(/SFU/);
  });

  test('E2EE off + mesh → no badge', () => {
    expect(pickBadge(false, false)).toBeNull();
  });
});
