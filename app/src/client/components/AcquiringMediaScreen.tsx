/** Acquiring media screen — shown while requesting camera/microphone access */
export function AcquiringMediaScreen() {
  return (
    <div id="pin-entry" class="card">
      <h2>Enter PIN to connect</h2>
      <form id="pin-form">
        <input type="text" id="pin-input" disabled placeholder="000000" />
        <button type="submit" id="connect-btn" disabled>
          Getting camera...
        </button>
      </form>
      <p class="hint">Share a 6-digit PIN with someone to start a call</p>
    </div>
  );
}
