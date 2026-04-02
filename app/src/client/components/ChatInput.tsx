/**
 * Chat input bar — textarea with send button.
 *
 * @module components/ChatInput
 */

import { useState, useCallback } from 'preact/hooks';
import type { RefObject } from 'preact';

interface ChatInputProps {
  /** Callback when user sends a message */
  onSend: (text: string) => void;
  /** External ref to the textarea element (for parent-driven refocus) */
  inputRef: RefObject<HTMLTextAreaElement>;
}

/** Chat input bar with auto-growing textarea and send button */
export function ChatInput({ onSend, inputRef }: ChatInputProps) {
  const [text, setText] = useState('');

  const canSend = text.trim().length > 0;

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onSend(trimmed);
    setText('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      // Re-focus textarea so mobile keyboard stays open after send
      inputRef.current.focus();
    }
  }, [text, onSend, inputRef]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleInput = useCallback((e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    setText(target.value);
    // Auto-grow: reset height then set to scrollHeight
    target.style.height = 'auto';
    target.style.height = `${String(target.scrollHeight)}px`;
  }, []);

  const handleFocus = useCallback(() => {
    // Safety net for iOS keyboard: scroll input into view after keyboard appears
    setTimeout(() => {
      inputRef.current?.scrollIntoView({ block: 'nearest' });
    }, 300);
  }, [inputRef]);

  return (
    <div class="chat-input-bar">
      <textarea
        ref={inputRef}
        class="chat-text-input"
        placeholder="Message..."
        rows={1}
        value={text}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
      />
      <button
        class="chat-send-btn"
        type="button"
        disabled={!canSend}
        onClick={handleSend}
        aria-label="Send message"
      >
        ➤
      </button>
    </div>
  );
}
