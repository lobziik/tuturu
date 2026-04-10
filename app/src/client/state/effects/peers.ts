/**
 * Peer nickname decryption side effects.
 *
 * When peers join the room, the server relays their encrypted nickname.
 * This effect decrypts each nickname asynchronously and dispatches
 * PEER_NICKNAME_RESOLVED to patch the peer's display name.
 *
 * @module state/effects/peers
 */

import { decryptMessage, fromBase64 } from '../../services/crypto';
import type { Dispatch } from '../context';
import type { EffectContext, EffectArgs } from './types';

/** Handle peer-related side effects: decrypt encrypted nicknames */
export function handlePeerEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, newState } = args;

  if (newState.phase !== 'room') return;
  const aesKey = refs.aesKey.current;
  if (!aesKey) return;

  if (action.type === 'PEERS_LIST') {
    for (const peer of action.peers) {
      decryptPeerNickname(aesKey, peer.peerId, peer.encryptedNickname, dispatch);
    }
  }

  if (action.type === 'PEER_JOINED_ROOM') {
    decryptPeerNickname(aesKey, action.peerId, action.encryptedNickname, dispatch);
  }
}

/**
 * Decrypt a peer's encrypted nickname and dispatch the result.
 * Fails silently (logs warning) if decryption fails — the UI will show
 * a truncated peerId as fallback.
 */
function decryptPeerNickname(
  aesKey: CryptoKey,
  peerId: string,
  encryptedNickname: string,
  dispatch: Dispatch,
): void {
  void (async () => {
    try {
      const wire = fromBase64(encryptedNickname);
      const plaintext = await decryptMessage(aesKey, wire);
      const nickname = new TextDecoder().decode(plaintext);
      dispatch({ type: 'PEER_NICKNAME_RESOLVED', peerId, nickname });
    } catch (err) {
      console.warn('[PEERS] Failed to decrypt nickname for', peerId, err);
    }
  })();
}
