/**
 * Media side effects — acquisition, track toggles, camera flip.
 *
 * @module state/effects/media
 */

import { getUserMedia, flipCamera } from '../../services/media';
import type { EffectContext, EffectArgs } from './types';
import { getScreen } from './types';

/** Handle media-related side effects */
export function handleMediaEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, prevState, newState } = args;
  const newScreen = getScreen(newState);
  const prevScreen = getScreen(prevState);

  // Entering acquiring-media → Request camera/microphone access
  if (newScreen?.type === 'acquiring-media' && prevScreen?.type !== 'acquiring-media') {
    void getUserMedia(dispatch);
  }

  // Toggle mute → Update audio track enabled state
  // 'in' operator narrows newScreen to variants that have 'muted' (waiting-for-peer | negotiating | call)
  if (
    action.type === 'TOGGLE_MUTE' &&
    refs.localStream.current &&
    newScreen &&
    'muted' in newScreen
  ) {
    const audioTrack = refs.localStream.current.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !newScreen.muted;
      console.log('[MEDIA] Audio', newScreen.muted ? 'muted' : 'unmuted');
    }
  }

  // Toggle video → Update video track enabled state
  if (
    action.type === 'TOGGLE_VIDEO' &&
    refs.localStream.current &&
    newScreen &&
    'videoOff' in newScreen
  ) {
    const videoTrack = refs.localStream.current.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !newScreen.videoOff;
      console.log('[MEDIA] Video', newScreen.videoOff ? 'off' : 'on');
    }
  }

  // Flip camera → Switch camera facing mode
  if (action.type === 'FLIP_CAMERA' && refs.localStream.current) {
    void flipCamera(refs.localStream.current, refs.pc.current, dispatch);
  }
}
