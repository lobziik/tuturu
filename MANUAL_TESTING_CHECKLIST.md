# Manual Testing Checklist - Frontend Refactor

This checklist verifies that the state machine refactor preserves all existing functionality.

## Pre-Testing Setup

- [ ] Build the client: `bun run build`
- [ ] Start the server: `bun run dev`
- [ ] Open `http://localhost:3000` in primary browser

---

## 1. PIN Entry Flow

### Valid PIN
- [ ] Enter valid 6-digit PIN (e.g., `123456`)
- [ ] Click "Connect" button
- [ ] Button changes to "Connecting..." and becomes disabled
- [ ] Button changes to "Getting camera..."
- [ ] Camera permission prompt appears

### Invalid PIN
- [ ] Enter invalid PIN (e.g., `abc123`, `12345`, `1234567`)
- [ ] Error message appears: "PIN must be exactly 6 digits"
- [ ] Error auto-dismisses after 5 seconds
- [ ] PIN entry remains accessible

---

## 2. Media Acquisition

### Camera + Audio (Normal Case)
- [ ] Grant camera and microphone permissions
- [ ] Local video appears (muted, playsinline)
- [ ] Status changes to "Waiting for peer..."
- [ ] PIN displayed at top: "PIN: 123456"

### Audio-Only Fallback
- [ ] Block camera permission (or disconnect camera)
- [ ] Allow microphone permission
- [ ] Warning shown: "Audio-only mode (no camera detected)"
- [ ] Video toggle button disabled (opacity 0.5)
- [ ] Status changes to "Waiting for peer..."

### Permission Denied
- [ ] Block both camera and microphone
- [ ] Error message: "Microphone permission denied. Please allow access and try again."
- [ ] Can retry by allowing permissions and clicking Connect again

---

## 3. WebRTC Connection (Two Peers)

### Setup
- [ ] Browser 1: Connected and waiting for peer (PIN: `123456`)
- [ ] Browser 2: Open `http://localhost:3000`
- [ ] Browser 2: Enter same PIN (`123456`)

### Connection Flow
- [ ] Browser 1: Status changes to "Calling peer..."
- [ ] Browser 2: Status changes to "Answering call..."
- [ ] Both browsers: Status changes to "Connected"
- [ ] Browser 1: Remote video shows Browser 2's camera
- [ ] Browser 2: Remote video shows Browser 1's camera
- [ ] Both browsers: Local video in corner (self-view)

### Console Logs (Action Stream)
Open browser console and verify action sequence:
- [ ] Browser 1: `[ACTION] PEER_JOINED` → `[ACTION] RTC_CONNECTED`
- [ ] Browser 2: `[ACTION] RECEIVED_OFFER` → `[ACTION] RTC_CONNECTED`
- [ ] Both browsers: `[RTC] Connection state: connected`

---

## 4. In-Call Controls

### Mute/Unmute Audio
- [ ] Click mute button
- [ ] Button becomes active (highlighted)
- [ ] Icon changes: 🎤 → 🔇
- [ ] Label changes: "Mute" → "Unmute"
- [ ] Remote peer cannot hear you (verify with partner)
- [ ] Click unmute button
- [ ] Button returns to normal
- [ ] Remote peer can hear you again

### Video On/Off
- [ ] Click video button
- [ ] Button becomes active (highlighted)
- [ ] Icon changes: 📹 → 🚫
- [ ] Label changes: "Video Off" → "Video On"
- [ ] Remote peer sees black screen (verify with partner)
- [ ] Local video still visible (self-view)
- [ ] Click video button again
- [ ] Remote peer sees video again

### Hangup
- [ ] Click hangup button
- [ ] Call ends immediately
- [ ] Returns to PIN entry screen
- [ ] Local video stopped (camera LED turns off)
- [ ] Remote peer shows: "The other person left the call"
- [ ] Console logs: `[WS] Connection closed: 1000 User ended call`

---

## 5. Error Scenarios

### Server Down
- [ ] Stop the server (`Ctrl+C`)
- [ ] Refresh browser, enter PIN, click Connect
- [ ] Error: "WebSocket connection failed. Check server is running."
- [ ] Error auto-dismisses after 5 seconds
- [ ] Start server: `bun run dev`
- [ ] Can retry connection successfully

### Room Full
- [ ] Browser 1 & 2: Connected with PIN `123456`
- [ ] Browser 3: Enter same PIN `123456`
- [ ] Error: "Room 123456 is full (maximum 2 clients)"
- [ ] Error does not auto-dismiss (canRetry: false)
- [ ] Must use different PIN or refresh page

### Network Interruption During Call
- [ ] Establish call between two browsers
- [ ] Disconnect network (WiFi off or unplug ethernet)
- [ ] Status shows: "Disconnected" (RTC_DISCONNECTED)
- [ ] Reconnect network
- [ ] **Expected**: Connection may or may not recover (no auto-reconnect yet)

### ICE Connection Failure
This is hard to test without specific network conditions, but verify error message:
- [ ] If connection fails: "Connection failed. Please check your network and try again."
- [ ] If ICE fails: "ICE connection failed. Your network may be blocking WebRTC..."

---

## 6. Multiple Errors Race Condition (Fixed)

Test that error timeout race condition is fixed:

- [ ] Trigger first error (e.g., invalid PIN: `abc`)
- [ ] Error appears
- [ ] Within 5 seconds, trigger second error (e.g., different invalid PIN: `xyz`)
- [ ] Second error replaces first immediately
- [ ] Second error auto-dismisses after 5 seconds
- [ ] **Verify**: Second error doesn't disappear early due to first timeout

---

## 7. Page Lifecycle

### Page Refresh During Call
- [ ] Establish call
- [ ] Refresh page (`Cmd+R` or `F5`)
- [ ] Camera LED turns off (cleanup successful)
- [ ] Returns to PIN entry screen
- [ ] Console shows cleanup logs
- [ ] Remote peer shows: "Connection closed: Connection lost (no close frame)"

### Page Close During Call
- [ ] Establish call
- [ ] Close browser tab/window
- [ ] Camera LED turns off
- [ ] Remote peer shows disconnect message

### Navigate Away
- [ ] Establish call
- [ ] Navigate to different URL
- [ ] Cleanup occurs (camera off)
- [ ] Remote peer disconnects

---

## 8. Console Action Stream Verification

Open browser console and verify all state transitions are logged:

### Expected Action Sequence (Full Flow)
```
[APP] tuturu WebRTC client initialized (state machine architecture)
[ACTION] SUBMIT_PIN { type: 'SUBMIT_PIN', pin: '123456' }
[STATUS] Connecting to server...
[WS] Creating connection to ws://localhost:3000/ws
[WS] Connected
[ACTION] WS_CONNECTED { type: 'WS_CONNECTED' }
[STATUS] Requesting camera access...
[MEDIA] Video + audio stream acquired
[ACTION] MEDIA_ACQUIRED { type: 'MEDIA_ACQUIRED', ... }
[STATUS] Waiting for peer...
[WS] Sending: join-pin
[WS] Received: peer-joined
[ACTION] PEER_JOINED { type: 'PEER_JOINED' }
[RTC] Creating peer connection
[RTC] Sent offer
[STATUS] Calling peer...
[WS] Received: answer
[ACTION] RECEIVED_ANSWER { type: 'RECEIVED_ANSWER', ... }
[RTC] Answer received and set
[RTC] Connection state: connected
[ACTION] RTC_CONNECTED { type: 'RTC_CONNECTED' }
[STATUS] Connected
```

- [ ] All actions logged with `[ACTION]` prefix
- [ ] No unexpected errors in console
- [ ] Action types match state machine design

---

## 9. State Machine Integrity

Verify state machine rejects invalid transitions:

### Toggle Mute Before Call
- [ ] At PIN entry screen, open console
- [ ] Manually dispatch: `dispatch({ type: 'TOGGLE_MUTE' })`
- [ ] **Verify**: Nothing happens (ignored in non-call state)

### Submit PIN During Call
- [ ] During active call, open console
- [ ] Manually dispatch: `dispatch({ type: 'SUBMIT_PIN', pin: '999999' })`
- [ ] **Verify**: Nothing happens (ignored in non-pin-entry state)

---

## 10. Mobile Testing (If Available)

### iOS Safari (Primary Target)
- [ ] Connect from iPhone/iPad with Safari
- [ ] Camera permission works
- [ ] Video has `playsinline` (no fullscreen takeover)
- [ ] Audio-only fallback if camera unavailable
- [ ] Mute/video controls work
- [ ] Portrait ↔ Landscape rotation works
- [ ] Screen lock during call stops video (expected iOS behavior)

### Chrome Android
- [ ] Connect from Android device
- [ ] Camera and microphone permissions work
- [ ] Video quality good (hardware acceleration)
- [ ] Controls work on touch screen (64x64 touch targets)
- [ ] Network switch (WiFi → Mobile data) handled gracefully

---

## 11. Cross-Browser Testing

Test in multiple browsers to verify compatibility:

- [ ] **Chrome**: All features work
- [ ] **Firefox**: All features work
- [ ] **Safari**: All features work
- [ ] **Edge**: All features work

---

## 12. Performance & Resource Cleanup

### Resource Leak Check
- [ ] Start call, hangup, start new call (repeat 5 times)
- [ ] **Verify**: No memory leaks (check Chrome DevTools Memory tab)
- [ ] **Verify**: Camera LED turns off every time
- [ ] **Verify**: No orphaned WebSocket connections (check Network tab)

### Bundle Size
- [ ] Check `public/index.js` size: Should be ~22-23 KB (gzipped ~7 KB)
- [ ] Check `public/index.js.map` exists for debugging

---

## Pass Criteria

All items must be checked ✅ for the refactor to be considered complete.

### Critical (Must Pass)
- All PIN entry flow tests
- WebRTC connection establishes
- In-call controls work (mute, video, hangup)
- Error messages are actionable
- No console errors during normal flow
- Resource cleanup on hangup/close

### Important (Should Pass)
- Error timeout race condition fixed
- Audio-only fallback works
- Mobile testing on iOS Safari passes
- Action stream logged correctly

### Nice to Have
- Cross-browser testing complete
- Mobile Android testing complete
- Performance checks pass

---

## Rollback Plan

If critical tests fail:

1. Revert `package.json` build script to: `src/client.ts`
2. Revert `public/index.html` script src to: `client.js`
3. Run `bun run build`
4. Old version restored

The old `client.ts` file is preserved for this purpose.

---

## Notes

- **Console logging**: All state transitions logged with `[ACTION]` prefix for debugging
- **Type safety**: TypeScript ensures no `any` types (strict mode)
- **FAIL FAST**: All errors are explicit with actionable messages
- **Mobile compatibility**: Preserves iOS Safari constraints (`ideal` not `exact`)

---

**Tester**: _________________
**Date**: _________________
**Result**: ☐ PASS  ☐ FAIL
**Notes**: _________________________________________________
