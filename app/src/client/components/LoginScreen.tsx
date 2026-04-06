/**
 * Login screen — passphrase + PIN entry with Argon2id key derivation.
 * Derives roomId + aesKey from credentials, then transitions to room phase.
 *
 * @module components/LoginScreen
 */

import { useState } from 'preact/hooks';
import type { Dispatch } from '../state/context';
import { openDB, getOrCreateDeviceId } from '../services/db';
import { deriveKeys } from '../services/crypto';

interface LoginScreenProps {
  /** User's display name (from nickname phase) */
  nickname: string;
  /** State dispatch function */
  dispatch: Dispatch;
}

/** Login screen: passphrase + 6-digit PIN → key derivation → room */
export function LoginScreen({ nickname, dispatch }: Readonly<LoginScreenProps>) {
  const [passphrase, setPassphrase] = useState('');
  const [pin, setPin] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const canSubmit = passphrase.trim().length > 0 && /^\d{6}$/.test(pin) && !isLoading;

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!canSubmit) return;

    setIsLoading(true);
    setError('');

    try {
      const db = await openDB();
      const deviceId = await getOrCreateDeviceId(db);
      const { roomId, aesKey } = await deriveKeys(passphrase.trim(), pin, location.hostname);
      console.log('[LoginScreen] Derived roomId:', roomId);
      dispatch({ type: 'SUBMIT_LOGIN', roomId, aesKey, deviceId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Key derivation failed';
      setError(message);
      setIsLoading(false);
    }
  };

  return (
    <div class="card">
      <p class="login-greeting">Hi, {nickname}</p>
      <h2>Join a room</h2>
      <form class="login-form" onSubmit={handleSubmit}>
        <input
          type="text"
          class="form-input"
          placeholder="Passphrase"
          autocomplete="off"
          value={passphrase}
          onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
          disabled={isLoading}
        />
        <input
          type="text"
          class="form-input form-input-pin"
          placeholder="000000"
          maxLength={6}
          pattern="\d{6}"
          inputMode="numeric"
          autocomplete="off"
          value={pin}
          onInput={(e) => setPin((e.target as HTMLInputElement).value)}
          disabled={isLoading}
        />
        {error && <p class="login-error">{error}</p>}
        {isLoading && <p class="login-loading">Deriving keys...</p>}
        <button type="submit" class="primary-btn" disabled={!canSubmit}>
          {isLoading ? 'Please wait...' : 'Enter'}
        </button>
      </form>
      <p class="hint">Enter a shared passphrase and PIN to join a room. Both should match. :)</p>
    </div>
  );
}
