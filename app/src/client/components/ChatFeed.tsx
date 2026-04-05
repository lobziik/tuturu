/**
 * Virtualized chat feed using virtua VList.
 * Renders messages with date separators, auto-scroll, and scroll-to-bottom button.
 *
 * @module components/ChatFeed
 */

import { useRef, useState, useEffect, useCallback, useMemo } from 'preact/hooks';
import { VList, type VListHandle } from 'virtua';
import type { ChatMessage } from '../../shared/schemas';
import { ChatBubble } from './ChatBubble';
import { ScrollToBottom } from './ScrollToBottom';

interface ChatFeedProps {
  /** Messages sorted by timestamp ascending */
  messages: ChatMessage[];
  /** Current user's device ID — used to identify own messages */
  selfDeviceId: string;
  /** Callback when user scrolls to top (for future pagination) */
  onLoadMore: () => void;
  /** Re-focus the chat input after scroll-to-bottom tap (keeps mobile keyboard open) */
  onRefocusInput: () => void;
}

// ============================================================================
// Feed item types — flat list of separators and messages for virtua
// ============================================================================

type FeedItem =
  | { kind: 'separator'; key: string; label: string }
  | { kind: 'message'; key: string; message: ChatMessage; isOwn: boolean; showSender: boolean };

/** Threshold in pixels from bottom to consider "at bottom" */
const AT_BOTTOM_THRESHOLD = 50;

/** Time gap (5 minutes) that forces showing sender name again */
const SENDER_GROUP_GAP_MS = 5 * 60_000;

// ============================================================================
// Date formatting helpers
// ============================================================================

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Format a timestamp as a human-readable date separator label */
function formatDateSeparator(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  if (isSameDay(date, now)) return 'Today';
  if (isSameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

// ============================================================================
// Build feed items from messages
// ============================================================================

function buildFeedItems(messages: ChatMessage[], selfDeviceId: string): FeedItem[] {
  const items: FeedItem[] = [];
  let lastDate: string | undefined;
  let lastDeviceId: string | undefined;
  let lastTimestamp = 0;

  for (const msg of messages) {
    // Date separator
    const dateLabel = formatDateSeparator(msg.timestamp);
    if (dateLabel !== lastDate) {
      items.push({ kind: 'separator', key: `sep-${dateLabel}`, label: dateLabel });
      lastDate = dateLabel;
      // Reset grouping after separator
      lastDeviceId = undefined;
    }

    // Show sender if different from previous or time gap > 5 min
    const isOwn = msg.deviceId === selfDeviceId;
    const showSender =
      msg.deviceId !== lastDeviceId || msg.timestamp - lastTimestamp > SENDER_GROUP_GAP_MS;

    items.push({ kind: 'message', key: msg.uuid, message: msg, isOwn, showSender });
    lastDeviceId = msg.deviceId;
    lastTimestamp = msg.timestamp;
  }

  return items;
}

// ============================================================================
// ChatFeed component
// ============================================================================

/** Virtualized chat feed with date separators, auto-scroll, and scroll-to-bottom */
export function ChatFeed({
  messages,
  selfDeviceId,
  onLoadMore,
  onRefocusInput,
}: Readonly<ChatFeedProps>) {
  const vListRef = useRef<VListHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const prevMessageCountRef = useRef(0);
  const loadMoreFiredRef = useRef(false);

  const feedItems = useMemo(() => buildFeedItems(messages, selfDeviceId), [messages, selfDeviceId]);

  // Auto-scroll to bottom when new messages arrive.
  // Own messages always scroll (like Telegram — you see what you just sent).
  // Other people's messages only scroll if user was already at bottom.
  useEffect(() => {
    const handle = vListRef.current;
    if (!handle || feedItems.length === 0) return;

    const isNewMessage = messages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    if (!isNewMessage) return;

    const lastMsg = messages.at(-1);
    const isOwnMessage = lastMsg?.deviceId === selfDeviceId;

    if (isOwnMessage || isAtBottom) {
      requestAnimationFrame(() => {
        handle.scrollToIndex(feedItems.length - 1, {
          align: 'end',
          smooth: isOwnMessage,
        });
      });
    }
  }, [feedItems.length, messages.length, isAtBottom, selfDeviceId]);

  // Scroll to bottom on mount
  useEffect(() => {
    const handle = vListRef.current;
    if (!handle || feedItems.length === 0) return;
    // Delay to let virtua measure items
    requestAnimationFrame(() => {
      handle.scrollToIndex(feedItems.length - 1, { align: 'end' });
    });
  }, []);

  const handleScroll = useCallback(
    (offset: number) => {
      const handle = vListRef.current;
      if (!handle) return;

      const atBottom = offset + handle.viewportSize >= handle.scrollSize - AT_BOTTOM_THRESHOLD;
      setIsAtBottom(atBottom);

      // Load more when near top
      if (offset < 100 && !loadMoreFiredRef.current) {
        loadMoreFiredRef.current = true;
        onLoadMore();
      }
      if (offset >= 100) {
        loadMoreFiredRef.current = false;
      }
    },
    [onLoadMore],
  );

  const handleScrollToBottom = useCallback(() => {
    const handle = vListRef.current;
    if (!handle || feedItems.length === 0) return;
    handle.scrollToIndex(feedItems.length - 1, { align: 'end', smooth: true });
    // Re-focus input so mobile keyboard stays open
    onRefocusInput();
  }, [feedItems.length, onRefocusInput]);

  return (
    <div class="chat-feed-container">
      <VList ref={vListRef} onScroll={handleScroll} shift={false} style={{ height: '100%' }}>
        {feedItems.map((item) => {
          if (item.kind === 'separator') {
            return (
              <div key={item.key} class="date-separator">
                <span>{item.label}</span>
              </div>
            );
          }
          return (
            <ChatBubble
              key={item.key}
              message={item.message}
              isOwn={item.isOwn}
              showSender={item.showSender}
            />
          );
        })}
      </VList>
      <ScrollToBottom visible={!isAtBottom} onClick={handleScrollToBottom} />
    </div>
  );
}
