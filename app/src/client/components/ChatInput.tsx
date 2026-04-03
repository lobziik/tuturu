/**
 * Chat input bar — contenteditable div with send button.
 * Uses contenteditable instead of textarea to avoid iOS Safari's
 * form accessory bar (prev/next/done toolbar above keyboard).
 *
 * @module components/ChatInput
 */

import { useState, useCallback } from 'preact/hooks';
import type { RefObject } from 'preact';

interface ChatInputProps {
  /** Callback when user sends a message */
  onSend: (text: string) => void;
  /** External ref to the editable element (for parent-driven refocus) */
  inputRef: RefObject<HTMLDivElement>;
}

/** Chat input bar with auto-growing contenteditable and send button */
export function ChatInput({ onSend, inputRef }: ChatInputProps) {
  const [canSend, setCanSend] = useState(false);

  /** Get plain text from editable div (innerText preserves line breaks from <br>) */
  const getText = (): string => inputRef.current?.innerText ?? '';

  /** Recalculate height to fit content, capped by CSS max-height */
  const autoGrow = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${String(el.scrollHeight)}px`;
  };

  const doSend = useCallback(() => {
    const trimmed = getText().trim();
    if (trimmed.length === 0) return;
    onSend(trimmed);
    if (inputRef.current) {
      inputRef.current.innerHTML = '';
      inputRef.current.style.height = 'auto';
      inputRef.current.focus();
    }
    setCanSend(false);
  }, [onSend, inputRef]);

  const handleInput = useCallback(() => {
    setCanSend(getText().trim().length > 0);
    autoGrow();
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

  /** Strip HTML on paste — only allow plain text */
  const handlePaste = useCallback((e: ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    document.execCommand('insertText', false, text);
  }, []);

  const handleFocus = useCallback(() => {
    // Safety net for iOS keyboard: scroll input into view after keyboard appears
    setTimeout(() => {
      inputRef.current?.scrollIntoView({ block: 'nearest' });
    }, 300);
  }, [inputRef]);

  /**
   * Prevent mousedown default on send button to stop it from stealing focus
   * from the editable div. Keeps iOS keyboard open after sending.
   */
  const preventFocusSteal = useCallback((e: MouseEvent) => {
    e.preventDefault();
  }, []);

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
        onPaste={handlePaste}
        onFocus={handleFocus}
      />
      <button
        class="chat-send-btn"
        type="button"
        disabled={!canSend}
        onMouseDown={preventFocusSteal}
        onClick={doSend}
        aria-label="Send message"
      >
        &#x27A4;
      </button>
    </div>
  );
}
