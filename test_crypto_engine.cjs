import crypto from 'crypto';

export class CryptoEngine {
  /**
   * Băm chuỗi dữ liệu đầu vào bằng thuật toán SHA-256 (Hex output)
   */
  static hashSHA256(data: string): string {
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
  }

  /**
   * Mã hóa chuỗi sang chuẩn Base64Url (an toàn cho URL/JWT)
   */
  static base64UrlEncode(str: string): string {
    return Buffer.from(str, 'utf8')
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }

  /**
   * Tạo chữ ký HMAC-SHA256 dạng Base64Url
   */
  static sign(payload: string, secret: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(payload, 'utf8')
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }

  /**
   * Xác thực chữ ký HMAC-SHA256 an toàn chống timing attack
   */
  static verifySignature(payload: string, signature: string, secret: string): boolean {
    const expectedSig = this.sign(payload, secret);
    if (expectedSig.length !== signature.length) {
      return false;
    }
    return crypto.timingSafeEqual(
      Buffer.from(expectedSig, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
  }
}

// ==========================================
// UNIT TESTS SUITE
// ==========================================
function runCryptoEngineTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: any) {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${testName}`, detail || '');
      failed++;
    }
  }

  console.log('================================================================');
  console.log('CRYPTO MULTI-ENGINE & INTEGRITY UNIT TEST SUITE');
  console.log('================================================================\n');

  // Test Case 1: Dữ liệu rỗng và chuỗi đặc biệt chứa Unicode tiếng Việt, tags XML/Bracket
  console.log('--- TEST 1: Hash SHA-256 & Base64Url với chuỗi đặc biệt & tiếng Việt ---');
  const emptyHash = CryptoEngine.hashSHA256('');
  assert(
    emptyHash === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'Hash SHA-256 chuỗi rỗng trả về đúng chuẩn FIPS'
  );

  const specialText = 'Ơ kìa! <talk> [SPAWN]';
  const specialHash = CryptoEngine.hashSHA256(specialText);
  assert(specialHash.length === 64, 'SHA-256 của chuỗi đặc biệt có độ dài chuẩn 64 hex chars');

  const b64Url = CryptoEngine.base64UrlEncode(specialText);
  assert(
    !b64Url.includes('+') && !b64Url.includes('/') && !b64Url.includes('='),
    'Base64Url không chứa các ký tự +, /, ='
  );

  // Test Case 2: Tạo và xác thực chữ ký HMAC-SHA256 hợp lệ
  console.log('\n--- TEST 2: Xác thực chữ ký đúng chuẩn ---');
  const secret = 'agentforge-secret-key-2026';
  const payload = '{"sub":"agent-007","role":"coder","action":"<spawn>"}';
  const validSignature = CryptoEngine.sign(payload, secret);

  const isVerified = CryptoEngine.verifySignature(payload, validSignature, secret);
  assert(isVerified === true, 'Chữ ký hợp lệ được xác thực thành công');

  // Test Case 3: Phát hiện chữ ký giả mạo hoặc payload bị chỉnh sửa
  console.log('\n--- TEST 3: Phát hiện chữ ký không hợp lệ / dữ liệu bị can thiệp ---');
  const tamperedPayload = '{"sub":"agent-007","role":"admin","action":"<spawn>"}';
  const verifyTamperedPayload = CryptoEngine.verifySignature(tamperedPayload, validSignature, secret);
  assert(verifyTamperedPayload === false, 'Từ chối payload bị can thiệp');

  const invalidSignature = validSignature.substring(0, validSignature.length - 2) + 'aa';
  const verifyInvalidSig = CryptoEngine.verifySignature(payload, invalidSignature, secret);
  assert(verifyInvalidSig === false, 'Từ chối chữ ký bị sai lệch');

  const wrongSecretVerify = CryptoEngine.verifySignature(payload, validSignature, 'wrong-secret');
  assert(wrongSecretVerify === false, 'Từ chối xác thực khi secret key không khớp');

  console.log('\n================================================================');
  console.log(`KẾT QUẢ: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  return { passed, failed };
}

runCryptoEngineTests();
