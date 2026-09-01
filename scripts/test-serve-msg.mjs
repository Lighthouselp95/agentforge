async function testSendAndListen() {
  const sessionId = 'ses_fbbdbef85ffevTYtzE49EkE5el';

  // 1. Mở SSE stream từ /event
  console.log('Connecting to SSE http://127.0.0.1:4096/event...');
  const controller = new AbortController();
  const sseRes = await fetch('http://127.0.0.1:4096/event', {
    signal: controller.signal
  });

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let finished = false;

  // Background read loop
  (async () => {
    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        const lines = text.split(/\r?\n/).filter(l => l.startsWith('data:'));
        for (const ln of lines) {
          const raw = ln.replace(/^data:\s*/, '').trim();
          if (!raw) continue;
          try {
            const ev = JSON.parse(raw);
            console.log(`[SSE Event] type=${ev.type} session=${ev.sessionID || ev.sessionId || 'global'}`, JSON.stringify(ev).slice(0, 160));
          } catch {}
        }
      }
    } catch (e) {
      // aborted
    }
  })();

  // 2. Gửi thử message qua POST /session/{sessionID}/message
  console.log('Sending message to session...');
  try {
    const msgRes = await fetch(`http://127.0.0.1:4096/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'orchestrator',
        parts: [
          { type: 'text', text: 'Hello, test response ngắn gọn 1 câu.' }
        ]
      })
    });
    console.log('Message POST status:', msgRes.status);
    const msgJson = await msgRes.json();
    console.log('Message POST response body:', JSON.stringify(msgJson).slice(0, 300));
  } catch (err) {
    console.error('Message POST failed:', err.message);
  }

  // Đợi 5s rồi đóng
  await new Promise(r => setTimeout(r, 5000));
  finished = true;
  controller.abort();
  console.log('Test completed.');
}

testSendAndListen();
