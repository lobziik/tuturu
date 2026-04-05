/**
 * Room screen — main chat view with header, message feed, and input bar.
 *
 * @module components/RoomScreen
 */

import { useCallback, useRef } from 'preact/hooks';
import type { ChatMessage } from '../../shared/schemas';
import type { Dispatch } from '../state/context';
import type { WsStatus } from '../state/types';
import { useVisualViewport, useTouchMovePrevention } from './roomHooks';
import { Header } from './Header';
import { ConnectionStatus } from './ConnectionStatus';
import { ChatFeed } from './ChatFeed';
import { ChatInput } from './ChatInput';

interface RoomScreenProps {
  /** Chat messages to display */
  messages: ChatMessage[];
  /** This device's unique identifier */
  deviceId: string;
  /** WebSocket connection status */
  wsStatus: WsStatus;
  /** Whether server has more history available */
  historyHasMore: boolean;
  /** State dispatch function */
  dispatch: Dispatch;
}

/** Room screen: header + connection status + virtualized chat feed + input bar */
export function RoomScreen({
  messages,
  deviceId,
  wsStatus,
  historyHasMore,
  dispatch,
}: Readonly<RoomScreenProps>) {
  const inputRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);

  useVisualViewport(screenRef);
  useTouchMovePrevention(screenRef);

  const handleCallClick = useCallback(() => {
    dispatch({ type: 'SWITCH_TO_CALL' });
  }, [dispatch]);

  const handleSend = useCallback(
    (text: string) => {
      dispatch({ type: 'SEND_MESSAGE', text });
    },
    [dispatch],
  );

  const handleLoadMore = useCallback(() => {
    if (!historyHasMore) return;
    dispatch({ type: 'REQUEST_HISTORY' });
  }, [historyHasMore, dispatch]);

  const handleRefocusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div ref={screenRef} class="room-screen">
      <Header onCallClick={handleCallClick} />
      <ConnectionStatus wsStatus={wsStatus} />
      <ChatFeed
        messages={messages}
        selfDeviceId={deviceId}
        onLoadMore={handleLoadMore}
        onRefocusInput={handleRefocusInput}
      />
      <ChatInput onSend={handleSend} inputRef={inputRef} disabled={wsStatus !== 'connected'} />
    </div>
  );
}
