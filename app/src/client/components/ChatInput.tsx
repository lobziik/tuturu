/**
 * Chat input bar — contenteditable div with send button.
 * Uses contenteditable instead of textarea to avoid iOS Safari's
 * form accessory bar (prev/next/done toolbar above keyboard).
 *
 * @module components/ChatInput
 */

import { useCallback, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';

interface ChatInputProps {
  /** Callback when user sends a message */
  onSend: (text: string) => void;
  /** External ref to the editable element (for parent-driven refocus) */
  inputRef: RefObject<HTMLDivElement>;
}

/** Chat input bar with auto-growing contenteditable and send button */
export function ChatInput({ onSend, inputRef }: ChatInputProps) {
  const canSendRef = useRef(false);

  /** Get plain text content from the editable div */
  const getText = (): string => inputRef.current?.textContent ?? '';

  const updateSendState = () => {
    canSendRef.current = getText().trim().length > 0;
  };

  const doSend = useCallback(() => {
    const trimmed = getText().trim();
    if (trimmed.length === 0) return;
    onSend(trimmed);
    if (inputRef.current) {
      inputRef.current.textContent = '';
      inputRef.current.focus();
    }
    canSendRef.current = false;
  }, [onSend, inputRef]);

  const handleInput = useCallback(() => {
    updateSendState();
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    },
    [doSend],
  );

  const handleFocus = useCallback(() => {
    setTimeout(() => {
      inputRef.current?.scrollIntoView({ block: 'nearest' });
    }, 300);
  }, [inputRef]);

  const handleSendClick = useCallback(() => {
    doSend();
  }, [doSend]);

  return (
    <div class="chat-input-bar">
      <div
        ref={inputRef}
        class="chat-text-input"
        contentEditable
        role="textbox"
        aria-label="Message"
        data-placeholder="Message..."
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
      />
      <button
        class="chat-send-btn"
        type="button"
        onClick={handleSendClick}
        aria-label="Send message"
      >
        &#x27A4;
      </button>
    </div>
  );
}
