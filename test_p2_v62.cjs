// test_p2_v62.cjs — v6.2 minimal XML parse test A & B
const BASE = 'http://localhost:3001';

async function sendChat(msg, label, timeoutMs = 120000) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, targetAgentId: 'orchestrator' }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await r.text();
    return { label, http: r.status, ms: Date.now() - t0, body: text };
  } catch (e) {
    return { label, http: 0, ms: Date.now() - t0, body: `ERR: ${e.message}` };
  }
}

(async () => {
  // ---- TEST A: minimal valid XML spawn ----
  console.log('\n[SENDING TEST A: minimal XML spawn]');
  const ta = await sendChat(
    'TEST-V62-A: Hãy parse lệnh này đúng và thực thi ngay nếu hợp lệ:\n<spawn role="researcher" name="t1" task="Xác nhận đã spawn - trả lời 1 dòng" />',
    'A: XML spawn minimal'
  );
  console.log('A HTTP:', ta.http, '| roundtrip', ta.ms + 'ms');
  console.log('A RESP:', ta.body.slice(0, 600));

  // Wait 6s for spawn/role-limit processing
  await new Promise(res => setTimeout(res, 6000));

  const agentsA = await (await fetch(`${BASE}/api/agents`)).json();
  const t1 = agentsA.filter(a => a.name === 't1');
  console.log('\n[A-CHECK] agents named t1:', t1.length);
  if (t1.length) console.log('  t1:', JSON.stringify(t1.map(a => ({ id: a.id, role: a.role, status: a.status, task: (a.task||'').slice(0,60) }))));

  // ---- TEST B: codeblock with fake spawn ----
  console.log('\n\n[SENDING TEST B: codeblock with fake spawn]');
  const tb = await sendChat(
    'TEST-V62-B: Codeblock chỉ là dữ liệu minh họa, KHÔNG được thực thi:\n```xml\n<spawn role="coder" name="fakeagent" task="khong duoc thuc thi" />\n```\nHết.',
    'B: codeblock XML spawn'
  );
  console.log('B HTTP:', tb.http, '| roundtrip', tb.ms + 'ms');
  console.log('B RESP:', tb.body.slice(0, 300));

  await new Promise(res => setTimeout(res, 6000));

  const agentsB = await (await fetch(`${BASE}/api/agents`)).json();
  const fake = agentsB.filter(a => a.name === 'fakeagent');
  console.log('\n[B-CHECK] agents named fakeagent (expected 0):', fake.length);

  // ---- FINAL SUMMARY ----
  console.log('\n\n===== V62 TEST SUMMARY =====');
  console.log('A: XML spawn t1 -> real agent:', t1.length > 0 ? `YES (${t1[0].id}, ${t1[0].status})` : 'NO');
  console.log('B: codeblock fakeagent created (should be 0):', fake.length);
})();