/**
 * Hooks for RoomScreen — iOS viewport workarounds.
 *
 * @module components/roomHooks
 */

import { useEffect } from 'preact/hooks';
import type { RefObject } from 'preact';

/**
 * Track iOS visualViewport to adjust room screen height when keyboard opens.
 * iOS Safari doesn't resize the layout viewport — instead it scrolls behind the keyboard.
 */
export function useVisualViewport(screenRef: RefObject<HTMLDivElement>): void {
  useEffect(() => {
    const screen = screenRef.current;
    const vv = window.visualViewport;
    if (!screen || !vv) return;

    const syncToVisualViewport = () => {
      screen.style.height = `${String(vv.height)}px`;
      screen.style.top = `${String(vv.offsetTop)}px`;
    };

    vv.addEventListener('resize', syncToVisualViewport);
    vv.addEventListener('scroll', syncToVisualViewport);

    return () => {
      vv.removeEventListener('resize', syncToVisualViewport);
      vv.removeEventListener('scroll', syncToVisualViewport);
      screen.style.height = '';
      screen.style.top = '';
    };
  }, []);
}

/**
 * Block touchmove on non-scrollable areas to prevent iOS from scrolling
 * the layout viewport behind the keyboard.
 */
export function useTouchMovePrevention(screenRef: RefObject<HTMLDivElement>): void {
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;

    const handler = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      // Allow scroll inside VList's scroll container, but NOT the overlay scroll-to-bottom button
      if (target.closest('.chat-feed-container') && !target.closest('.scroll-to-bottom')) return;
      // Allow scroll inside overflowing contenteditable input
      const editable = target.closest('[contenteditable]') as HTMLElement | null;
      if (editable && editable.scrollHeight > editable.clientHeight) return;
      e.preventDefault();
    };

    screen.addEventListener('touchmove', handler, { passive: false });
    return () => screen.removeEventListener('touchmove', handler);
  }, []);
}
