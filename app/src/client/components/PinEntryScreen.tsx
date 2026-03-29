import { useState } from 'preact/hooks';
import type { Dispatch } from '../state/context';

interface PinEntryScreenProps {
  dispatch: Dispatch;
}

/** PIN entry screen — user enters 6-digit PIN to start a call */
export function PinEntryScreen({ dispatch }: PinEntryScreenProps) {
  const [pin, setPin] = useState('');

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(pin)) {
      dispatch({ type: 'MEDIA_ERROR', error: 'PIN must be exactly 6 digits' });
      return;
    }
    dispatch({ type: 'SUBMIT_PIN', pin });
  };

  return (
    <div id="pin-entry" class="card">
      <h2>Enter PIN to connect</h2>
      <form id="pin-form" onSubmit={handleSubmit}>
        <input
          type="text"
          id="pin-input"
          placeholder="000000"
          maxLength={6}
          pattern="\d{6}"
          required
          autocomplete="off"
          value={pin}
          onInput={(e) => setPin((e.target as HTMLInputElement).value)}
        />
        <button type="submit" id="connect-btn">
          Connect
        </button>
      </form>
      <p class="hint">Share a 6-digit PIN with someone to start a call</p>
    </div>
  );
}
