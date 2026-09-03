// test_p2_e2e.cjs - AgentForge PART 2 end-to-end mock test against running server (port 3001)
const BASE = 'http://127.0.0.1:3001';
const results = [];

async function sendChat(message, targetAgentId = 'orchestrator', label) {
  const payload = { message, targetAgentId };
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await r.text();
    const ms = Date.now() - t0;
    return { label, http: r.status, ms, body: text };
  } catch (e) {
    return { label, http: 0, ms: Date.now() - t0, body: `ERR: ${e.message}` };
  }
}

function record(label, pass, evidence) {
  results.push({ label, pass, evidence });
  console.log(`\n=== ${label} ===`);
  console.log(pass ? '  [PASS]' : '  [FAIL]');
  console.log(`  Evidence: ${evidence}`);
}

async function main() {
  console.log('================================================================');
  console.log('AGENTFORGE PART 2 E2E MOCK TEST (against live server :3001)');
  console.log('================================================================');

  // CASE 3: valid <talk> and [SPAWN] - command executed, not misinterpreted
  const c3 = await sendChat(
    'TEST-P2-C3: Hãy parse đúng lệnh này: <talk target="debugroot" task="Phản hồi xác nhận đã nhận TASK-P2-C3">Xác nhận nhận lệnh P2-C3</talk> và [SPAWN role=researcher name=tux task="Tạo báo cáo 1 dòng P2-C3"]',
    'orchestrator',
    'CASE 3: <talk> + [SPAWN] hợp lệ'
  );
  console.log('RAW:', c3.body.slice(0, 700));

  await new Promise(res => setTimeout(res, 8000));

  // Verify agents created / talk delivered via /api/agents
  try {
    const agents = await (await fetch(`${BASE}/api/agents`)).json();
    const found = agents.filter(a => a.name === 'tux' || (a.name === 'debugroot' && a.task && a.task.includes('P2-C3')));
    record('CASE 3: SPAWN tạo agent / TALK cập nhật task',
      found.length > 0,
      `Agents matching: ${JSON.stringify(found.map(a => ({ name: a.name, role: a.role, status: a.status, task: (a.task || '').slice(0, 60) })))}`);
  } catch (e) {
    record('CASE 3: SPAWN tạo agent', false, `ERR: ${e.message}`);
  }

  console.log('\n---- KẾT QUẢ TỔNG ----');
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} | ${r.label}`);
  }
}

main().catch(e => console.error('FATAL', e));
