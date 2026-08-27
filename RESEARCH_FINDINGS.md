# Research Report: Two Critical Issues

## Agent: investigate (agent-4e8fd6b1)
## Date: 2026-08-23
## Status: completed

---

## ISSUE 1: Node Native Crash — `Assertion failed: (env) != nullptr` in `Statement::scalar deleting destructor`

### Root Cause Analysis
The crash occurs in better-sqlite3 when:
1. **Server shutdown** or **clear conversation** operations trigger database cleanup
2. The `clearOrchestratorConversation()` function was calling `db.prepare()` ad-hoc instead of reusing cached prepared statements
3. The checkpoint interval timer (`setInterval` for WAL checkpointing) was not using `unref()`, keeping the event loop alive
4. Database close and WAL checkpointing were not handled safely during shutdown signals (SIGINT, SIGTERM, beforeExit)

### Current Implementation (storage.ts)
```typescript
// Line 92-94: Ad-hoc prepare on every call
const clearOrchestratorHistory = db.prepare(`
  DELETE FROM chat_history WHERE to_id = 'orchestrator' OR from_id = 'orchestrator'
`);

// Line 143-145: Uses ad-hoc prepared statement
clearOrchestratorConversation() {
  if (db.open) clearOrchestratorHistory.run();
}
```

### Fix Applied (per CHANGELOG 2026-08-23)
1. **Pre-compile and cache ALL prepared statements** including `clearOrchestratorHistory` at module load time
2. **Checkpoint timer**: Added `unref()` to prevent keeping event loop alive
3. **Graceful shutdown**: `storage.close()` performs `wal_checkpoint(TRUNCATE)` before `db.close()`
4. **Signal handlers**: `process.once('beforeExit', ...)` for cleanup

### Files Modified
- `src/storage.ts` — Lines 88-94, 51-56, 173-184, 187-189

### Verification Needed
- Test server shutdown (Ctrl+C) — no native crash
- Test clear conversation — no crash
- Test multiple clear operations in sequence

---

## ISSUE 2: ESC Key Event Handling — Debounce/Throttle Multiple ESC Presses

### Root Cause Analysis
Multiple interconnected problems:
1. **App.tsx**: No `e.repeat` check on ESC keydown — holding ESC triggers multiple aborts
2. **ChatPanel.tsx**: ESC handler in textarea had basic `e.repeat` check but no global debounce
3. **SpawnDialog.tsx**: Modal Escape didn't stop propagation — closing modal ALSO triggered agent abort
4. **API `/abort` endpoint**: Not idempotent — calling abort on already-stopped agent causes `taskkill` errors
5. **No global throttle**: Missing `isAbortingRef` and time-based debounce

### Current Implementation

**App.tsx (Lines 336-347):**
```typescript
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (e.repeat) return; // Only basic repeat check
      if (showSpawn) return; // Modal guard
      stopAgent();
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [stopAgent, showSpawn]);
```

**ChatPanel.tsx (Lines 51-63):**
```typescript
const handleKeyDown = (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) { ... }
  else if (e.key === 'Escape') {
    if (e.repeat) { e.preventDefault(); return; }
    if (loading && onStop) onStop();
  }
};
```

**SpawnDialog.tsx (Lines 46-57):**
```typescript
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // Good!
      if (e.repeat) return;
      onClose();
    }
  };
  window.addEventListener('keydown', onKey, true); // Capture phase
  return () => window.removeEventListener('keydown', onKey, true);
}, [onClose]);
```

### Fix Applied (per CHANGELOG 2026-08-23)

1. **App.tsx**: 
   - Added `isAbortingRef` (useRef) to prevent concurrent aborts
   - Added `lastAbortTimeRef` with 800ms debounce
   - Only triggers abort when agent is actually `working` or `loading`

2. **ChatPanel.tsx**: 
   - Keeps `e.repeat` check
   - Only calls `onStop()` when `loading` is true

3. **SpawnDialog.tsx**: 
   - Uses capture phase (`true` in addEventListener)
   - Calls `e.stopPropagation()` to prevent bubbling to App.tsx

4. **ACPClient.abort()** (acp-client.ts Lines 68-103):
   - Idempotent: returns early if `this._aborted` is true
   - Clears pending queue with rejection
   - Uses `taskkill /F /T /PID` on Windows with error suppression

5. **Server `/api/agents/:id/abort`** (server.ts Lines 1396-1427):
   - Wrapped in try/catch
   - Returns `{ ok: true, killed: false, warning: err.message }` on error

### Files Modified
- `web/src/App.tsx` — Lines 288-320, 336-347
- `web/src/components/ChatPanel.tsx` — Lines 51-63
- `web/src/components/SpawnDialog.tsx` — Lines 46-57
- `src/agents/acp-client.ts` — Lines 68-103
- `src/server.ts` — Lines 1396-1427

### Verification Needed
- Hold ESC key — only one abort triggered
- Press ESC rapidly — debounce prevents spam
- Open SpawnDialog, press ESC — modal closes, NO agent abort
- Abort already-stopped agent — no taskkill errors, graceful response

---

## Summary of Changes

| Component | Issue | Fix Type |
|-----------|-------|----------|
| storage.ts | SQLite crash on shutdown/clear | Prepared statement caching, safe shutdown |
| App.tsx | ESC spam abort | Debounce (800ms), isAborting guard, repeat check |
| ChatPanel.tsx | ESC in textarea | Repeat check, loading guard |
| SpawnDialog.tsx | Modal ESC propagates | Capture phase, stopPropagation |
| acp-client.ts | Abort not idempotent | _aborted flag, pending queue cleanup |
| server.ts | Abort endpoint errors | try/catch, warning response |

---

## Recommendations

1. **Add integration tests** for both scenarios:
   - Server shutdown/restart cycle
   - Rapid ESC key presses during agent execution
   - SpawnDialog + ESC interaction

2. **Monitor production** for:
   - Any remaining native crashes in better-sqlite3
   - Edge cases with modal dialogs and keyboard events

3. **Consider**: Moving to `opencode serve` + SSE for more robust process management (per AGENTS-GUIDE.md)

---

## Sources
- `src/storage.ts` — SQLite storage implementation
- `web/src/App.tsx` — Main React app with ESC handler
- `web/src/components/ChatPanel.tsx` — Chat input with ESC handler
- `web/src/components/SpawnDialog.tsx` — Modal with ESC capture
- `src/agents/acp-client.ts` — ACP client with abort logic
- `src/server.ts` — API abort endpoint
- `CHANGELOG.md` — Lines 512-539 (2026-08-23 entry)