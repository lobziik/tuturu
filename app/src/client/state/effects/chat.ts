/**
 * Chat side effects — message sending and history pagination.
 *
 * Handles SEND_MESSAGE (encrypt → WS send → IDB persist) and
 * REQUEST_HISTORY (send history-request to server).
 *
 * @module state/effects/chat
 */

import type { EffectContext, EffectArgs } from './types';
import type { ChatMessage } from '../../../shared/schemas';
import { sendMessage } from '../../services/websocket';
import { encryptMessage, toBase64 } from '../../services/crypto';
import { putMessage, putOwnSeq } from '../../services/db';

/** Handle chat-related side effects */
export function handleChatEffects(ctx: EffectContext, args: EffectArgs): void {
  const { refs, dispatch } = ctx;
  const { action, newState } = args;

  if (newState.phase !== 'room') return;

  // === SEND_MESSAGE → build message, optimistic UI, async encrypt + send ===
  if (action.type === 'SEND_MESSAGE') {
    const { roomId, deviceId, nickname } = newState;
    const aesKey = refs.aesKey.current;
    const ws = refs.ws.current;
    const db = refs.db.current;

    if (!aesKey || !ws || !db) {
      console.warn('[CHAT] Cannot send: missing aesKey, ws, or db');
      return;
    }

    if (!refs.seqLoaded.current) {
      console.error('[CHAT] Cannot send: seq counter not yet loaded from IDB');
      return;
    }

    const seq = ++refs.seq.current;
    const uuid = crypto.randomUUID();
    const timestamp = Date.now();

    const message: ChatMessage = {
      v: 1,
      deviceId,
      seq,
      uuid,
      sender: nickname,
      timestamp,
      type: 'text',
      text: action.text,
    };

    // Optimistic UI — show message immediately
    dispatch({ type: 'CHAT_RECEIVED', message });

    // Async: encrypt, send to server, persist to IDB
    void (async () => {
      try {
        const plaintext = new TextEncoder().encode(JSON.stringify(message));
        const encrypted = await encryptMessage(aesKey, plaintext);
        const blob = toBase64(encrypted);

        sendMessage(ws, {
          type: 'chat',
          v: 1,
          roomId,
          blob,
          uuid,
        });

        await putMessage(db, roomId, message);
        await putOwnSeq(db, roomId, deviceId, seq);
      } catch (err) {
        console.error('[CHAT] Send failed:', err);
      }
    })();
  }

  // === REQUEST_HISTORY → send history-request to server ===
  if (action.type === 'REQUEST_HISTORY') {
    if (!newState.historyHasMore || newState.historyCursor === null) return;

    sendMessage(refs.ws.current, {
      type: 'history-request',
      v: 1,
      roomId: newState.roomId,
      before: newState.historyCursor,
    });
  }
}
