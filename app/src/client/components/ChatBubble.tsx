/**
 * Individual chat message bubble — text or photo placeholder.
 *
 * @module components/ChatBubble
 */

import type { ChatMessage } from '../../shared/schemas';

interface ChatBubbleProps {
  /** The message to render */
  message: ChatMessage;
  /** Whether this message is from the current user */
  isOwn: boolean;
  /** Whether to show the sender name (first in a group) */
  showSender: boolean;
}

/** Format timestamp as HH:MM */
function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Chat message bubble with sender name, text/photo content, and timestamp */
export function ChatBubble({ message, isOwn, showSender }: ChatBubbleProps) {
  const rowClass = `chat-bubble-row ${isOwn ? 'own' : ''} ${showSender ? 'has-sender' : ''}`;
  const bubbleClass = `chat-bubble ${isOwn ? 'own' : 'other'}`;

  return (
    <div class={rowClass}>
      <div class={bubbleClass}>
        {!isOwn && showSender && <div class="chat-sender">{message.sender}</div>}
        {message.type === 'text' && <div class="chat-text">{message.text}</div>}
        {message.type === 'photo' && (
          <div class="chat-photo-placeholder">
            <span class="chat-photo-placeholder-icon">📷</span>
            <span>Photo</span>
          </div>
        )}
        <div class="chat-timestamp">{formatTime(message.timestamp)}</div>
      </div>
    </div>
  );
}
