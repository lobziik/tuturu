/**
 * Chat input bar — contenteditable div with send button.
 * Uses contenteditable instead of textarea to avoid iOS Safari's
 * form accessory bar (prev/next/done toolbar above keyboard).
 *
 * @module components/ChatInput
 */

import { useState, useCallback } from 'preact/hooks';
import type { RefObject } from 'preact';
import { PaperAirplaneIcon } from '@heroicons/react/24/solid';

interface ChatInputProps {
  /** Callback when user sends a message */
  onSend: (text: string) => void;
  /** External ref to the editable element (for parent-driven refocus) */
  inputRef: RefObject<HTMLDivElement>;
  /** When true, input is greyed out and send is blocked (e.g. WS disconnected) */
  disabled?: boolean;
}

/** Chat input bar with auto-growing contenteditable and send button */
export function ChatInput({ onSend, inputRef, disabled = false }: Readonly<ChatInputProps>) {
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
    if (disabled) return;
    const trimmed = getText().trim();
    if (trimmed.length === 0) return;
    onSend(trimmed);
    if (inputRef.current) {
      inputRef.current.innerHTML = '';
      inputRef.current.style.height = 'auto';
      inputRef.current.focus();
    }
    setCanSend(false);
  }, [onSend, inputRef, disabled]);

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
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    selection.collapseToEnd();
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
    <div
      class={`flex items-end gap-2 px-4 py-2 pb-safe bg-surface-light border-t border-surface-border shrink-0${disabled ? ' opacity-50 pointer-events-none' : ''}`}
    >
      <div // NOSONAR: contenteditable used intentionally in attempt to avoid iOS Safari form accessory bar.
        // Doesn't work, though... :/
        ref={inputRef}
        class="chat-editable flex-1 px-4 py-2.5 text-base font-sans bg-surface text-txt border border-surface-border rounded-[1.25rem] outline-none max-h-24 leading-snug overflow-y-auto whitespace-pre-wrap wrap-break-word select-text focus:border-brand"
        contentEditable={!disabled}
        role="textbox"
        aria-label="Message"
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        data-placeholder={disabled ? 'Offline...' : 'Message...'}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={handleFocus}
      />
      <button
        class="size-10 rounded-full bg-brand text-white border-none shrink-0 flex items-center justify-center p-0 cursor-pointer transition-opacity hover:bg-brand-dark disabled:opacity-40 disabled:cursor-not-allowed"
        type="button"
        disabled={!canSend || disabled}
        onMouseDown={preventFocusSteal}
        onClick={doSend}
        aria-label="Send message"
      >
        <PaperAirplaneIcon class="size-5" />
      </button>
    </div>
  );
}
