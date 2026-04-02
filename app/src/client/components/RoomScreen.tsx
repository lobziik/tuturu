/**
 * Room screen — main chat view with header, message feed, and input bar.
 *
 * @module components/RoomScreen
 */

import { useEffect, useCallback, useRef } from 'preact/hooks';
import type { ChatMessage } from '../../shared/schemas';
import type { Dispatch } from '../state/context';
import { Header } from './Header';
import { ChatFeed } from './ChatFeed';
import { ChatInput } from './ChatInput';
import {
  generateMockMessages,
  MOCK_SELF_DEVICE_ID,
  MOCK_SELF_NICKNAME,
} from '../mock/mockMessages';

interface RoomScreenProps {
  /** Chat messages to display */
  messages: ChatMessage[];
  /** State dispatch function */
  dispatch: Dispatch;
}

/** Mock sequence counter for locally sent messages */
let mockSendSeq = 1000;

/** Room screen: header + virtualized chat feed + input bar */
export function RoomScreen({ messages, dispatch }: RoomScreenProps) {
  const initialLoadDone = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load mock messages on mount
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;
    dispatch({ type: 'LOAD_MOCK_MESSAGES', messages: generateMockMessages() });
  }, [dispatch]);

  const handleCallClick = useCallback(() => {
    dispatch({ type: 'SWITCH_TO_CALL' });
  }, [dispatch]);

  const handleSend = useCallback(
    (text: string) => {
      const message: ChatMessage = {
        v: 1,
        deviceId: MOCK_SELF_DEVICE_ID,
        seq: ++mockSendSeq,
        uuid: `mock-send-${String(mockSendSeq)}`,
        sender: MOCK_SELF_NICKNAME,
        timestamp: Date.now(),
        type: 'text',
        text,
      };
      dispatch({ type: 'MOCK_SEND_MESSAGE', message });
    },
    [dispatch],
  );

  const handleLoadMore = useCallback(() => {
    // TODO(session-8): request history from server
    console.log('[ChatFeed] Load more triggered (no-op in mock mode)');
  }, []);

  const handleRefocusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div class="room-screen">
      <Header onCallClick={handleCallClick} />
      <ChatFeed
        messages={messages}
        selfDeviceId={MOCK_SELF_DEVICE_ID}
        onLoadMore={handleLoadMore}
        onRefocusInput={handleRefocusInput}
      />
      <ChatInput onSend={handleSend} inputRef={inputRef} />
    </div>
  );
}
