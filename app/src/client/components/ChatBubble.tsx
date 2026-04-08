/**
 * Individual chat message bubble — text or photo placeholder.
 *
 * @module components/ChatBubble
 */

import { CameraIcon } from '@heroicons/react/24/outline';
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
export function ChatBubble({ message, isOwn, showSender }: Readonly<ChatBubbleProps>) {
  const rowClass = `flex px-4 py-0.5${isOwn ? ' justify-end' : ''}${showSender ? ' pt-2' : ''}`;
  const bubbleClass = `max-w-[75%] px-3 py-2 rounded-2xl break-words text-[0.9375rem] leading-snug relative${
    isOwn
      ? ' bg-brand text-white rounded-br-sm'
      : ' bg-surface-light border border-surface-border rounded-bl-sm'
  }`;

  return (
    <div class={rowClass}>
      <div class={bubbleClass}>
        {!isOwn && showSender && (
          <div class="text-xs font-semibold text-brand mb-0.5">{message.sender}</div>
        )}
        {message.type === 'text' && <div class="whitespace-pre-wrap">{message.text}</div>}
        {message.type === 'photo' && (
          <div class="w-50 aspect-4/3 bg-surface-border rounded-lg flex flex-col items-center justify-center gap-1 text-txt-muted text-sm">
            <CameraIcon class="size-6" />
            <span>Photo</span>
          </div>
        )}
        <div
          class={`text-[0.6875rem] text-right mt-1${isOwn ? ' text-white/70' : ' text-txt-muted'}`}
        >
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
}
