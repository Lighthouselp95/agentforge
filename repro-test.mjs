// Reproduction test: which parser regex produces corrupted target '\s*([^'
const reTalk = /(?:agent-id|agent_id|target-id|target_id|target|agent|to|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i;
const reTag  = /(?:agent-id|agent_id|target-id|target_id|target|agent|to|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s\]]+))/i;
const reSpawn= /\btask\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s>]+))/i;

function matchRe(re, s) {
  const m = s.match(re);
  if (!m) return 'NO';
  return JSON.stringify(m[1] || m[2] || m[3] || m[4] || m[5]);
}

const cases = [
  ['target="abc"', 'talk'],
  ["target='abc'", 'talk'],
  ['target=abc', 'talk'],
  // unquoted target followed by message containing regex text (escaped)
  ['target=agent-x task="fix \'\\s*([^\\']"', 'talk'],
  ["target='\\'\\s*([^'", 'talk'],
  // message body containing a regex literal in single quotes
  ["target='\\&quot;\\\\s*([^'\" ", 'talk'],
];

for (const [s, kind] of cases) {
  const out = kind === 'talk'
    ? `reTalk=${matchRe(reTalk, s)} reTag=${matchRe(reTag, s)}`
    : matchRe(reTag, s);
  console.log('INPUT:', JSON.stringify(s));
  console.log('  ', out);
}

// Simulate the exact corrupted string as a target value
const corrupted = '\\s*([^\'';
console.log('\nCorrupted literal as target attr value:');
console.log('  reTalk on target='+JSON.stringify(corrupted)+':', matchRe(reTalk, 'target="'+corrupted+'"'));
console.log('  reTag  on target='+JSON.stringify(corrupted)+':', matchRe(reTag, 'target="'+corrupted+'"'));