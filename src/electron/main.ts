import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let SERVER_PORT = parseInt(process.env.PORT || '3001', 10);

// ========== PATH HELPERS ==========
function isDev(): boolean {
  return !app.isPackaged;
}

function getProjectRoot(): string {
  if (isDev()) {
    // dist-electron/main.js → ../../ = project root (1 level up from dist-electron)
    return path.resolve(__dirname, '..');
  }
  // Packaged: resources/app/
  return path.join(process.resourcesPath, 'app');
}

function getFrontendPath(): string {
  return path.join(getProjectRoot(), 'dist', 'index.html');
}

// ========== PORT & SERVER CHECK ==========
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/agents`, { timeout: 2000 }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Raw TCP probe: is the port actually open (by ANY process)?
function isTcpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (free: boolean) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      resolve(free);
    };
    sock.once('connect', () => done(false));   // port is occupied
    sock.once('error', () => done(true));       // port is free
    sock.setTimeout(1500, () => done(false));   // timeout → treat as occupied (safe)
  });
}

// Resolve the actual port to use:
//  1) if default port is free → use it
//  2) if default port is occupied by OUR server → reuse it
//  3) if default port is occupied by an EXTERNAL server → pick next free port
async function findServerPort(): Promise<number> {
  if (await isTcpPortFree(SERVER_PORT)) return SERVER_PORT;
  if (await isPortInUse(SERVER_PORT)) {
    console.log(`[Electron] Port ${SERVER_PORT} đã bị chiếm bởi AgentForge — sẽ tái sử dụng.`);
    return SERVER_PORT;
  }
  for (let p = SERVER_PORT + 1; p <= SERVER_PORT + 50; p++) {
    if (await isTcpPortFree(p)) {
      console.log(`[Electron] Port ${SERVER_PORT} đang bị server khác chiếm → dùng port ${p} cho backend.`);
      return p;
    }
  }
  console.error(`[Electron] Fatal: không tìm thấy port trống gần ${SERVER_PORT}.`);
  process.exit(1);
}

function waitForServer(port: number, timeoutMs: number = 30000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/agents`, { timeout: 2000 }, () => resolve(true));
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(poll, 500);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
    };
    poll();
  });
}

async function ensureServerRunning(): Promise<void> {
  // Resolve which port the backend should actually use.
  const resolvedPort = await findServerPort();
  const alreadyRunning = await isPortInUse(resolvedPort);
  SERVER_PORT = resolvedPort;

  // If our server is already running on that port (e.g. started externally) — skip spawn.
  if (alreadyRunning) {
    console.log(`[Electron] Port ${SERVER_PORT} already running our server — reusing existing.`);
    return;
  }

  // Only packaged mode (or standalone) needs to spawn its own server.
  const projectRoot = getProjectRoot();
  const fs = await import('fs');
  const tsxBin = path.join(projectRoot, 'node_modules', '.bin', 'tsx');

  console.log(`[Electron] Starting backend server on port ${SERVER_PORT}...`);
  console.log(`[Electron] Project root: ${projectRoot}`);

  const hasTsx = fs.existsSync(tsxBin) || fs.existsSync(tsxBin + '.cmd');
  if (hasTsx) {
    serverProcess = spawn(process.execPath, [tsxBin, 'src/server.ts'], {
      cwd: projectRoot,
      env: { ...process.env, PORT: String(SERVER_PORT) },
      stdio: 'pipe'
    });
  } else {
    // Fallback: compiled JS
    serverProcess = spawn(process.execPath, ['dist/server.js'], {
      cwd: projectRoot,
      env: { ...process.env, PORT: String(SERVER_PORT) },
      stdio: 'pipe'
    });
  }

  serverProcess.stdout?.on('data', (d) => console.log(`[Server] ${d.toString().trim()}`));
  serverProcess.stderr?.on('data', (d) => console.error(`[Server] ${d.toString().trim()}`));
  serverProcess.on('exit', (code) => {
    console.log(`[Electron] Server exited (code ${code})`);
    serverProcess = null;
  });
}

// ========== WINDOW ==========
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'hiddenInset',
    autoHideMenuBar: true
  });

  if (isDev()) {
    // Dev: frontend is served by Vite on 5173, API proxied to backend on SERVER_PORT
    mainWindow.loadURL('http://localhost:' + SERVER_PORT);
    if (process.env.OPEN_DEVTOOLS) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadFile(getFrontendPath());
  }

  mainWindow.once('ready-to-show', () => { mainWindow?.show(); mainWindow?.focus(); });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ========== CLEANUP ==========
function cleanup(): void {
  if (serverProcess) {
    console.log('[Electron] Shutting down backend server...');
    try {
      serverProcess.kill('SIGTERM');
      setTimeout(() => { try { serverProcess?.kill('SIGKILL'); } catch {} }, 3000);
    } catch (e) { console.error('[Electron] Kill error:', e); }
    serverProcess = null;
  }
}

// ========== APP LIFECYCLE ==========
app.on('ready', async () => {
  console.log(`[Electron] Mode: ${isDev() ? 'development' : 'production'}`);

  // 1. Ensure backend is running (skip if already started externally)
  await ensureServerRunning();

  // 2. Wait until backend responds
  console.log(`[Electron] Waiting for server on port ${SERVER_PORT}...`);
  const ready = await waitForServer(SERVER_PORT, 30000);
  if (!ready) {
    console.warn(`[Electron] Server not ready after 30s — loading UI anyway.`);
  }

  // 3. Create browser window
  createWindow();
});

app.on('window-all-closed', () => { cleanup(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
app.on('before-quit', cleanup);

// ========== IPC ==========
ipcMain.handle('get-port', () => SERVER_PORT);
ipcMain.handle('is-dev', () => isDev());
