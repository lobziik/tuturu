/**
 * Media side effects — acquisition, track toggles, camera flip.
 *
 * @module state/effects/media
 */

import type { Screen } from '../types';
import { getUserMedia, flipCamera } from '../../services/media';
import type { EffectContext, EffectArgs } from './types';

/** Screen types that support media controls (muted, videoOff) */
type MediaControlScreen = Extract<
  Screen,
  { type: 'waiting-for-peer' } | { type: 'negotiating' } | { type: 'call' }
>;

/** Whether a screen type supports media controls */
function isMediaControlScreen(type: Screen['type']): boolean {
  return type === 'waiting-for-peer' || type === 'negotiating' || type === 'call';
}

/** Handle media-related side effects */
export function handleMediaEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, prevScreen, newScreen } = args;
  const newState = args.newState;

  // Entering acquiring-media → Request camera/microphone access
  if (newScreen === 'acquiring-media' && prevScreen !== 'acquiring-media') {
    void getUserMedia(dispatch);
  }

  // Toggle mute → Update audio track enabled state
  if (action.type === 'TOGGLE_MUTE' && refs.localStream.current) {
    const audioTrack = refs.localStream.current.getAudioTracks()[0];
    if (audioTrack && isMediaControlScreen(newScreen)) {
      const screen = newState.screen as MediaControlScreen;
      audioTrack.enabled = !screen.muted;
      console.log('[MEDIA] Audio', screen.muted ? 'muted' : 'unmuted');
    }
  }

  // Toggle video → Update video track enabled state
  if (action.type === 'TOGGLE_VIDEO' && refs.localStream.current) {
    const videoTrack = refs.localStream.current.getVideoTracks()[0];
    if (videoTrack && isMediaControlScreen(newScreen)) {
      const screen = newState.screen as MediaControlScreen;
      videoTrack.enabled = !screen.videoOff;
      console.log('[MEDIA] Video', screen.videoOff ? 'off' : 'on');
    }
  }

  // Flip camera → Switch camera facing mode
  if (action.type === 'FLIP_CAMERA' && refs.localStream.current) {
    void flipCamera(refs.localStream.current, refs.pc.current, dispatch);
  }
}
