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
    <div class="flex flex-col items-center justify-center min-h-screen min-h-dvh p-4">
      <div class="bg-surface-light border border-surface-border rounded-2xl p-8 w-full max-w-md text-center">
        <p class="text-base text-txt-muted mb-2">Hi, {nickname}</p>
        <h2 class="text-2xl font-bold mb-6">Join a room</h2>
        <form class="flex flex-col gap-4" onSubmit={handleSubmit}>
          <input
            type="text"
            class="w-full p-4 text-base font-sans bg-surface text-txt border-2 border-surface-border rounded-lg focus:outline-none focus:border-brand disabled:opacity-50"
            placeholder="Passphrase"
            autocomplete="off"
            value={passphrase}
            onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
            disabled={isLoading}
          />
          <input
            type="text"
            class="w-full p-4 text-base font-sans bg-surface text-txt border-2 border-surface-border rounded-lg focus:outline-none focus:border-brand disabled:opacity-50 text-3xl text-center tracking-[0.5rem] font-mono"
            placeholder="000000"
            maxLength={6}
            pattern="\d{6}"
            inputMode="numeric"
            autocomplete="off"
            value={pin}
            onInput={(e) => setPin((e.target as HTMLInputElement).value)}
            disabled={isLoading}
          />
          {error && <p class="text-sm text-danger text-center">{error}</p>}
          {isLoading && <p class="text-sm text-brand text-center">Deriving keys...</p>}
          <button
            type="submit"
            class="bg-brand text-white px-6 py-3 text-base font-semibold border-none rounded-lg cursor-pointer transition-colors hover:bg-brand-dark disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!canSubmit}
          >
            {isLoading ? 'Please wait...' : 'Enter'}
          </button>
        </form>
        <p class="mt-4 text-sm text-txt-muted">
          Enter a shared passphrase and PIN to join a room. Both should match. :)
        </p>
      </div>
    </div>
  );
}
