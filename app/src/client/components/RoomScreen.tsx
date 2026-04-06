/**
 * Room screen — main chat view with header, message feed, input bar,
 * and floating call PiP.
 *
 * @module components/RoomScreen
 */

import { useCallback, useRef } from 'preact/hooks';
import type { ChatMessage } from '../../shared/schemas';
import type { PeerState } from '../../shared/types';
import type { Dispatch } from '../state/context';
import type { WsStatus, Screen } from '../state/types';
import { useVisualViewport, useTouchMovePrevention } from './roomHooks';
import { Header } from './Header';
import { ConnectionStatus } from './ConnectionStatus';
import { ChatFeed } from './ChatFeed';
import { ChatInput } from './ChatInput';
import { FloatingCallPiP } from './FloatingCallPiP';

interface RoomScreenProps {
  /** Chat messages to display */
  messages: ChatMessage[];
  /** This device's unique identifier */
  deviceId: string;
  /** WebSocket connection status */
  wsStatus: WsStatus;
  /** Whether server has more history available */
  historyHasMore: boolean;
  /** Connected peers in the room */
  peers: Record<string, PeerState>;
  /** Current call screen state */
  screen: Screen;
  /** Whether a call is active in the room (from server broadcast) */
  callActive: boolean;
  /** Remote peer's media stream (for floating PiP) */
  remoteStream: MediaStream | null;
  /** State dispatch function */
  dispatch: Dispatch;
}

/** Room screen: header + connection status + virtualized chat feed + input bar */
export function RoomScreen({
  messages,
  deviceId,
  wsStatus,
  historyHasMore,
  peers,
  screen,
  callActive,
  remoteStream,
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

  const peerCount = Object.keys(peers).length + 1;
  const callDisabled =
    screen.type !== 'idle' || wsStatus !== 'connected' || Object.keys(peers).length === 0;

  // Show floating PiP when call is active but view is chat (minimized)
  const showFloatingPiP =
    screen.type === 'waiting-for-peer' || screen.type === 'negotiating' || screen.type === 'call';

  return (
    <div ref={screenRef} class="room-screen">
      <Header
        onCallClick={handleCallClick}
        peerCount={peerCount}
        callDisabled={callDisabled}
        inCall={showFloatingPiP || callActive}
      />
      <ConnectionStatus wsStatus={wsStatus} />
      <ChatFeed
        messages={messages}
        selfDeviceId={deviceId}
        onLoadMore={handleLoadMore}
        onRefocusInput={handleRefocusInput}
      />
      <ChatInput onSend={handleSend} inputRef={inputRef} disabled={wsStatus !== 'connected'} />
      {showFloatingPiP && <FloatingCallPiP remoteStream={remoteStream} dispatch={dispatch} />}
    </div>
  );
}
