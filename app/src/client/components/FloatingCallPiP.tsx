/**
 * Floating Picture-in-Picture for minimized call — shows remote video
 * (or phone icon for audio-only) as a small draggable overlay on the chat screen.
 *
 * @module components/FloatingCallPiP
 */

import { useEffect, useRef, useCallback } from 'preact/hooks';
import type { Dispatch } from '../state/context';

interface FloatingCallPiPProps {
  /** Remote peer's media stream (null if not yet received) */
  remoteStream: MediaStream | null;
  /** State dispatch function */
  dispatch: Dispatch;
}

/** Small floating window showing the remote video during a minimized call */
export function FloatingCallPiP({ remoteStream, dispatch }: Readonly<FloatingCallPiPProps>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );

  // Set remote video srcObject
  useEffect(() => {
    if (videoRef.current && remoteStream) {
      videoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // Pointer event handlers for drag
  const onPointerDown = useCallback((e: PointerEvent) => {
    const el = containerRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.left,
      origY: rect.top,
    };
  }, []);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const el = containerRef.current;
    const ds = dragState.current;
    if (!el || !ds) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    el.style.left = `${ds.origX + dx}px`;
    el.style.top = `${ds.origY + dy}px`;
    el.style.right = 'auto';
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const el = containerRef.current;
      if (!el) return;
      el.releasePointerCapture(e.pointerId);

      // Only open full call if it wasn't a drag (pointer didn't move much)
      const ds = dragState.current;
      if (ds) {
        const dx = Math.abs(e.clientX - ds.startX);
        const dy = Math.abs(e.clientY - ds.startY);
        if (dx < 5 && dy < 5) {
          dispatch({ type: 'SWITCH_TO_CALL' });
        }
      }
      dragState.current = null;
    },
    [dispatch],
  );

  const hasVideo = remoteStream !== null && remoteStream.getVideoTracks().length > 0;

  return (
    <div
      ref={containerRef}
      class="floating-call-pip"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {hasVideo ? (
        <video ref={videoRef} autoplay playsinline class="floating-pip-video" />
      ) : (
        <span class="floating-pip-icon">{'\uD83D\uDCDE'}</span>
      )}
    </div>
  );
}
