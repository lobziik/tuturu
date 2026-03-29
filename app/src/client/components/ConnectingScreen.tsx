/** Connecting screen — shown while WebSocket connection is being established */
export function ConnectingScreen() {
  return (
    <div id="pin-entry" class="card">
      <h2>Enter PIN to connect</h2>
      <form id="pin-form">
        <input type="text" id="pin-input" disabled placeholder="000000" />
        <button type="submit" id="connect-btn" disabled>
          Connecting...
        </button>
      </form>
      <p class="hint">Share a 6-digit PIN with someone to start a call</p>
    </div>
  );
}
