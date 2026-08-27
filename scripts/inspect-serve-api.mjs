async function checkDoc() {
  try {
    const res = await fetch('http://127.0.0.1:4096/doc');
    const text = await res.text();
    const matches = Array.from(text.matchAll(/["'](\/(?:session|event|global|config|auth|message)[^"']*)["']/g)).map(m => m[1]);
    const unique = Array.from(new Set(matches));
    console.log('Detected Endpoints in OpenCode Serve:\n', unique.sort().join('\n'));
  } catch (err) {
    console.error('Fetch /doc error:', err.message);
  }
}
checkDoc();
