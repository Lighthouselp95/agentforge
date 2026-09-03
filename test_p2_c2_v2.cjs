// test_p2_c2_v2.cjs — Case C2: thinking field on new --thinking build
const BASE = 'http://127.0.0.1:3001';

(async () => {
  // Capture SSE events in background during the chat
  let thinkingEvents = [];
  let opencodeMsgs = 0;
  let beforeCount = null;

  // Open SSE stream
  let reader = null;
  try {
    const r = await fetch(`${BASE}/api/events`, { signal: AbortSignal.timeout(60000) });
    reader = r.body.getReader();
  } catch (e) {
    console.log('SSE open failed:', e.message);
  }

  const decoder = new TextDecoder();
  let buf = '';
  const readerTask = (async () => {
    if (!reader) return;
    while (true) {
      try {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'chat:message' && data.msg) {
              const m = data.msg;
              if (m.msgType === 'opencode') opencodeMsgs++;
              if (m.thinking && String(m.thinking).trim()) {
                thinkingEvents.push({ from: m.from, role: m.agentRole, tl: String(m.thinking).length, preview: String(m.thinking).slice(0, 100) });
              }
            }
          } catch (e) {}
        }
      } catch (e) { break; }
    }
  })();

  // Send a chat that should produce reasoning
  const msg = 'TEST-V2-C2: Hãy suy nghĩ kỹ (reasoning) rồi tính toán: 17 * 23 = ? Trả lời đúng 1 dòng.';
  const t0 = Date.now();
  const out = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, targetAgentId: 'orchestrator' }),
    signal: AbortSignal.timeout(120000)
  });
  const text = await out.text();
  const ms = Date.now() - t0;
  console.log('chat HTTP:', out.status, '| roundtrip', ms + 'ms');
  console.log('chat RESP:', text.slice(0, 400));

  // Wait to capture any trailing opencode events
  await new Promise(res => setTimeout(res, 8000));

  // Grab history
  const hist = await (await fetch(`${BASE}/api/messages`)).json();
  const withTh = hist.filter(m => m.thinking && String(m.thinking).trim());
  const c2msgs = hist.filter(m => (m.content||'').includes('TEST-V2-C2'));

  console.log('\n===== CASE C2: THINKING FIELD (new build) =====');
  console.log('SSE opencode msgs during window:', opencodeMsgs);
  console.log('SSE msgs WITH thinking:', thinkingEvents.length);
  if (thinkingEvents.length) {
    console.log('SSE thinking samples:', JSON.stringify(thinkingEvents.slice(0,5), null, 1));
  }
  console.log('history msgs WITH thinking (total ever):', withTh.length);
  if (withTh.length) {
    withTh.slice(-5).forEach(m => console.log('  - from', m.from, '| role', m.agentRole, '| thinkingLen', String(m.thinking).length, '|', String(m.thinking).slice(0, 80)));
  }
  console.log('c2 test msgs found:', c2msgs.length, '(last', c2msgs.slice(-1)[0]?.from, ')');
})();
