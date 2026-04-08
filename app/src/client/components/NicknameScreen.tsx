/**
 * Nickname entry screen — shown on first launch.
 * Saves the chosen nickname to IndexedDB and transitions to login phase.
 *
 * @module components/NicknameScreen
 */

import { useState } from 'preact/hooks';
import { UserIcon } from '@heroicons/react/24/outline';
import type { Dispatch } from '../state/context';
import { openDB, putSetting } from '../services/db';

interface NicknameScreenProps {
  /** State dispatch function */
  dispatch: Dispatch;
}

/** First-launch screen: user enters their display name */
export function NicknameScreen({ dispatch }: Readonly<NicknameScreenProps>) {
  const [nickname, setNickname] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const trimmed = nickname.trim();
  const canSubmit = trimmed.length > 0 && !saving;

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!canSubmit) return;

    setSaving(true);
    setError('');

    try {
      const db = await openDB();
      await putSetting(db, 'nickname', trimmed);
      dispatch({ type: 'SUBMIT_NICKNAME', nickname: trimmed });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save nickname';
      setError(message);
      setSaving(false);
    }
  };

  return (
    <div class="flex flex-col items-center justify-center min-h-screen min-h-dvh p-4">
      <div class="bg-surface-light border border-surface-border rounded-2xl p-8 w-full max-w-md text-center">
        <UserIcon class="w-10 h-10 text-brand mx-auto mb-4" />
        <h2 class="text-2xl font-bold mb-6">What's your name?</h2>
        <form class="flex flex-col gap-4" onSubmit={handleSubmit}>
          <input
            type="text"
            class="w-full p-4 text-base font-sans bg-surface text-txt border-2 border-surface-border rounded-lg focus:outline-none focus:border-brand disabled:opacity-50"
            placeholder="Name"
            maxLength={30}
            autocomplete="off"
            value={nickname}
            onInput={(e) => setNickname((e.target as HTMLInputElement).value)}
            disabled={saving}
          />
          {error && <p class="text-sm text-danger text-center">{error}</p>}
          <button
            type="submit"
            class="bg-brand text-white px-6 py-3 text-base font-semibold border-none rounded-lg cursor-pointer transition-colors hover:bg-brand-dark disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!canSubmit}
          >
            {saving ? 'Saving...' : 'Continue'}
          </button>
        </form>
        <p class="mt-4 text-sm text-txt-muted">Other room members will see this name</p>
      </div>
    </div>
  );
}
