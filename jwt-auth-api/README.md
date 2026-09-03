# JWT Authentication API

He thong API xac thuc nguoi dung su dung JSON Web Token (JWT) tieu chuan HS256, hoan toan zero-dependency (chi dung Node.js built-in modules nhu node:crypto va node:http), hieu suat cao, nhe va san sang cho production.

## Tinh nang chinh

- Thuat toan ma hoa mat khau: PBKDF2 voi salt ngau nhien (100,000 iterations, SHA-512) va so sanh thoi gian thuc (timingSafeEqual) chong timing attack.
- Co che JWT HS256: Tu dong ky, xac thuc token, kiem tra han dung (exp), kiem tra thoi diem co hieu luc (nbf), chong gia mao chu ky.
- Token Pair: Tra ve Access Token (thoi han ngan, mac dinh 15 phut) va Refresh Token (thoi han dai, mac dinh 7 ngay).
- Refresh Token Rotation: Xoay vong refresh token tu dong khi lam moi de chong replay attack.
- Rate Limiting: Bo dem chan tan cong brute-force tren cac endpoint xac thuc.
- CORS & Defensive Parser: Ho tro CORS day du, gioi han dung luong payload tranh DoS, xu ly ngoai le tap trung.

## Cau truc thu muc

- package.json: Thong tin package va script chay test
- src/crypto.js: Cac ham ma hoa mat khau PBKDF2 va tao token ngau nhien
- src/jwt.js: Bo ma hoa, giai ma, ky va xac minh JWT HS256 doc lap
- src/db.js: Lop quan ly luu tru nguoi dung va token (ho tro ghi tep an toan)
- src/auth.service.js: Nghiep vu dang ky, dang nhap, lam moi token, dang xuat
- src/server.js: HTTP Server tiep nhan request, rate limiting, route dispatcher
- src/index.js: Entry point khoi dong he thong voi graceful shutdown
- test/auth.test.js: Bo kiem thu tu dong toan dien

## Danh sach API Endpoints

### 1. Health Check
- Method: GET
- Path: /health
- Response (200):
```json
{
  "success": true,
  "status": "ok",
  "service": "jwt-auth-api",
  "uptime": 12.34
}
```

### 2. Dang ky tai khoan (Register)
- Method: POST
- Path: /api/auth/register
- Body:
```json
{
  "username": "user123",
  "email": "user@example.com",
  "password": "mySecurePassword123"
}
```
- Response (201):
```json
{
  "success": true,
  "message": "User registered successfully",
  "data": {
    "user": {
      "id": "uuid-here",
      "username": "user123",
      "email": "user@example.com",
      "role": "user",
      "createdAt": "2026-08-28T00:00:00.000Z"
    }
  }
}
```

### 3. Dang nhap lay JWT (Login)
- Method: POST
- Path: /api/auth/login
- Body:
```json
{
  "identifier": "user@example.com",
  "password": "mySecurePassword123"
}
```
- Response (200):
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": {
      "id": "uuid-here",
      "username": "user123",
      "email": "user@example.com",
      "role": "user"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "48-byte-hex-token",
    "tokenType": "Bearer",
    "expiresIn": 900
  }
}
```

### 4. Lam moi Access Token (Refresh)
- Method: POST
- Path: /api/auth/refresh
- Body:
```json
{
  "refreshToken": "48-byte-hex-token"
}
```
- Response (200): Tra ve access token moi va refresh token moi duoc xoay vong.

### 5. Dang xuat (Logout)
- Method: POST
- Path: /api/auth/logout
- Body:
```json
{
  "refreshToken": "48-byte-hex-token"
}
```
- Response (200):
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

### 6. Lay thong tin nguoi dung (Protected Route)
- Method: GET
- Path: /api/auth/me hoac /api/user/profile
- Headers:
  Authorization: Bearer <accessToken>
- Response (200):
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid-here",
      "username": "user123",
      "email": "user@example.com",
      "role": "user"
    },
    "payload": {
      "sub": "uuid-here",
      "username": "user123",
      "email": "user@example.com",
      "role": "user",
      "iat": 1787884500,
      "exp": 1787885400
    }
  }
}
```

## Huong dan chay va kiem thu

1. Chay kiem thu tu dong:
node --test test/auth.test.js

2. Khoi dong server:
node src/index.js
(Mac dinh chay tai cong 4000)
