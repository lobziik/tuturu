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
  const { action, prevState, newState } = args;
  const newScreen = getScreen(newState);
  const prevScreen = getScreen(prevState);
  const sfuMode = newState.phase === 'room' && newState.sfuMode;

  if (newScreen?.type === 'acquiring-media' && prevScreen?.type !== 'acquiring-media') {
    void getUserMedia(ctx.dispatch);
  }

  if (action.type === 'TOGGLE_MUTE') {
    handleMuteToggle(ctx, newScreen, sfuMode);
  } else if (action.type === 'TOGGLE_VIDEO') {
    handleVideoToggle(ctx, newScreen, sfuMode);
  } else if (action.type === 'FLIP_CAMERA') {
    handleFlipCamera(ctx, sfuMode);
  }
}

/** Apply audio track enabled state for mesh mode (SFU pauses via producer instead). */
function handleMuteToggle(
  ctx: EffectContext,
  newScreen: ReturnType<typeof getScreen>,
  sfuMode: boolean,
): void {
  if (sfuMode || !ctx.refs.localStream.current || !newScreen || !('muted' in newScreen)) return;
  const audioTrack = ctx.refs.localStream.current.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !newScreen.muted;
  console.log('[MEDIA] Audio', newScreen.muted ? 'muted' : 'unmuted');
}

/** Apply video track enabled state for mesh mode (SFU pauses via producer instead). */
function handleVideoToggle(
  ctx: EffectContext,
  newScreen: ReturnType<typeof getScreen>,
  sfuMode: boolean,
): void {
  if (sfuMode || !ctx.refs.localStream.current || !newScreen || !('videoOff' in newScreen)) return;
  const videoTrack = ctx.refs.localStream.current.getVideoTracks()[0];
  if (!videoTrack) return;
  videoTrack.enabled = !newScreen.videoOff;
  console.log('[MEDIA] Video', newScreen.videoOff ? 'off' : 'on');
}

/** Switch camera facing mode and propagate the new track to peer connections or SFU producer. */
function handleFlipCamera(ctx: EffectContext, sfuMode: boolean): void {
  const { refs, dispatch } = ctx;
  if (!refs.localStream.current) return;

  if (!sfuMode) {
    void flipCamera(refs.localStream.current, refs.peerConnections.current, dispatch);
    return;
  }

  // SFU mode: track replacement happens via producer.replaceTrack(), not peer connections.
  void (async () => {
    try {
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
}
