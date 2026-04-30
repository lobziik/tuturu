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
import { PeerListDrawer } from './PeerListDrawer';
import { SettingsOverlay } from './SettingsOverlay';

interface RoomScreenProps {
  /** Chat messages to display */
  messages: ChatMessage[];
  /** This device's unique identifier */
  deviceId: string;
  /** Current user's display name */
  nickname: string;
  /** WebSocket connection status */
  wsStatus: WsStatus;
  /** Current reconnect attempt number (0 = not reconnecting) */
  reconnectAttempt: number;
  /** Whether server has more history available */
  historyHasMore: boolean;
  /** Connected peers in the room */
  peers: Record<string, PeerState>;
  /** Current call screen state */
  screen: Screen;
  /** Whether a call is active in the room (from server broadcast) */
  callActive: boolean;
  /** Remote peers' media streams keyed by peerId (for floating PiP) */
  remoteStreams: Map<string, MediaStream>;
  /** Currently open overlay panel */
  overlay: 'peers' | 'settings' | null;
  /** Whether the server requires E2EE for media (drives the encryption badge) */
  e2eeMediaEnabled: boolean;
  /** Whether the room uses SFU topology (vs mesh) */
  sfuMode: boolean;
  /** State dispatch function */
  dispatch: Dispatch;
}

/** Room screen: header + connection status + virtualized chat feed + input bar */
export function RoomScreen({
  messages,
  deviceId,
  nickname,
  wsStatus,
  reconnectAttempt,
  historyHasMore,
  peers,
  screen,
  callActive,
  remoteStreams,
  overlay,
  e2eeMediaEnabled,
  sfuMode,
  dispatch,
}: Readonly<RoomScreenProps>) {
  const inputRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);

  useVisualViewport(screenRef);
  useTouchMovePrevention(screenRef);

  const handleCallClick = useCallback(() => {
    dispatch({ type: 'SWITCH_TO_CALL' });
  }, [dispatch]);

  const handlePeersClick = useCallback(() => {
    dispatch({ type: 'OPEN_OVERLAY', overlay: 'peers' });
  }, [dispatch]);

  const handleSettingsClick = useCallback(() => {
    dispatch({ type: 'OPEN_OVERLAY', overlay: 'settings' });
  }, [dispatch]);

  const handleCloseOverlay = useCallback(() => {
    dispatch({ type: 'CLOSE_OVERLAY' });
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
  const callDisabled = screen.type !== 'idle' || wsStatus !== 'connected';

  // Show floating PiP when call is active but view is chat (minimized)
  const showFloatingPiP = screen.type === 'waiting-for-peer' || screen.type === 'call';

  return (
    <div ref={screenRef} class="room-screen">
      <Header
        onCallClick={handleCallClick}
        onPeersClick={handlePeersClick}
        onSettingsClick={handleSettingsClick}
        peerCount={peerCount}
        callDisabled={callDisabled}
        inCall={showFloatingPiP || callActive}
        e2eeMediaEnabled={e2eeMediaEnabled}
        sfuMode={sfuMode}
      />
      <ConnectionStatus
        wsStatus={wsStatus}
        reconnectAttempt={reconnectAttempt}
        dispatch={dispatch}
      />
      <ChatFeed
        messages={messages}
        selfDeviceId={deviceId}
        onLoadMore={handleLoadMore}
        onRefocusInput={handleRefocusInput}
      />
      <ChatInput onSend={handleSend} inputRef={inputRef} disabled={wsStatus !== 'connected'} />
      {showFloatingPiP && <FloatingCallPiP remoteStreams={remoteStreams} dispatch={dispatch} />}
      {overlay === 'peers' && (
        <PeerListDrawer peers={peers} selfNickname={nickname} onClose={handleCloseOverlay} />
      )}
      {overlay === 'settings' && (
        <SettingsOverlay nickname={nickname} dispatch={dispatch} onClose={handleCloseOverlay} />
      )}
    </div>
  );
}
