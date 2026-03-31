/**
 * Media side effects — acquisition, track toggles, camera flip.
 *
 * @module state/effects/media
 */

import { getUserMedia, flipCamera } from '../../services/media';
import type { EffectContext, EffectArgs } from './types';

/** Handle media-related side effects */
export function handleMediaEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, prevState, newState } = args;

  // Entering acquiring-media → Request camera/microphone access
  if (newState.screen.type === 'acquiring-media' && prevState.screen.type !== 'acquiring-media') {
    void getUserMedia(dispatch);
  }

  // Toggle mute → Update audio track enabled state
  // 'in' operator narrows newState.screen to variants that have 'muted' (waiting-for-peer | negotiating | call)
  if (action.type === 'TOGGLE_MUTE' && refs.localStream.current && 'muted' in newState.screen) {
    const audioTrack = refs.localStream.current.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !newState.screen.muted;
      console.log('[MEDIA] Audio', newState.screen.muted ? 'muted' : 'unmuted');
    }
  }

  // Toggle video → Update video track enabled state
  if (action.type === 'TOGGLE_VIDEO' && refs.localStream.current && 'videoOff' in newState.screen) {
    const videoTrack = refs.localStream.current.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !newState.screen.videoOff;
      console.log('[MEDIA] Video', newState.screen.videoOff ? 'off' : 'on');
    }
  }

  // Flip camera → Switch camera facing mode
  if (action.type === 'FLIP_CAMERA' && refs.localStream.current) {
    void flipCamera(refs.localStream.current, refs.pc.current, dispatch);
  }
}
