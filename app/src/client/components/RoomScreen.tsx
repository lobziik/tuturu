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
  const inputRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);

  // VisualViewport tracking — iOS Safari doesn't resize the layout viewport
  // when the keyboard opens. Instead, it scrolls the fixed-position page behind
  // the keyboard. We listen to visualViewport resize/scroll events and manually
  // set the room screen's height and top to match the actual visible area.
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

  // Block touchmove on non-scrollable areas to prevent iOS from scrolling the
  // layout viewport behind the keyboard. Allow scroll only inside the chat feed
  // (VList manages its own scroll) and overflowing contenteditable input.
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;

    const handler = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      // Allow scroll inside chat feed (VList's scroll container)
      if (target.closest('.chat-feed-container')) return;
      // Allow scroll inside overflowing contenteditable input
      const editable = target.closest('[contenteditable]') as HTMLElement | null;
      if (editable && editable.scrollHeight > editable.clientHeight) return;
      e.preventDefault();
    };

    screen.addEventListener('touchmove', handler, { passive: false });
    return () => screen.removeEventListener('touchmove', handler);
  }, []);

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
    <div ref={screenRef} class="room-screen">
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
