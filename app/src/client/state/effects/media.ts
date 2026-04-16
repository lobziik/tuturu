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

  // Toggle mute → Update audio track enabled state (mesh mode only — SFU uses producer pause)
  const sfuMode = newState.phase === 'room' && newState.sfuMode;
  if (
    action.type === 'TOGGLE_MUTE' &&
    !sfuMode &&
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

  // Toggle video → Update video track enabled state (mesh mode only — SFU uses producer pause)
  if (
    action.type === 'TOGGLE_VIDEO' &&
    !sfuMode &&
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
    if (sfuMode) {
      // SFU mode: flip camera, then replace track on video producer
      void (async () => {
        try {
          // Empty Map: in SFU mode track replacement happens via producer.replaceTrack() below, not peer connections
          await flipCamera(refs.localStream.current!, new Map(), dispatch);
          const videoProducer = refs.sfuProducers.current.get('video');
          const newVideoTrack = refs.localStream.current?.getVideoTracks()[0];
          if (videoProducer && newVideoTrack) {
            await videoProducer.replaceTrack({ track: newVideoTrack });
            console.log('[MEDIA] Replaced track on SFU video producer');
          }
        } catch (error) {
          console.error('[MEDIA] Failed to replace track on SFU producer:', error);
        }
      })();
    } else {
      // Mesh mode: replaces track in all peer connections
      void flipCamera(refs.localStream.current, refs.peerConnections.current, dispatch);
    }
  }
}
