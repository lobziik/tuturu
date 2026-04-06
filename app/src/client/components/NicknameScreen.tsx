/**
 * Nickname entry screen — shown on first launch.
 * Saves the chosen nickname to IndexedDB and transitions to login phase.
 *
 * @module components/NicknameScreen
 */

import { useState } from 'preact/hooks';
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
    <div class="card">
      <h2>What's your name?</h2>
      <form class="login-form" onSubmit={handleSubmit}>
        <input
          type="text"
          class="form-input"
          placeholder="Name"
          maxLength={30}
          autocomplete="off"
          value={nickname}
          onInput={(e) => setNickname((e.target as HTMLInputElement).value)}
          disabled={saving}
        />
        {error && <p class="login-error">{error}</p>}
        <button type="submit" class="primary-btn" disabled={!canSubmit}>
          {saving ? 'Saving...' : 'Continue'}
        </button>
      </form>
      <p class="hint">Other room members will see this name</p>
    </div>
  );
}
