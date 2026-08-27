import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import http from 'http';
import fs from 'fs';

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
    return path.resolve(__dirname, '..');
  }
  return path.join(process.resourcesPath, 'app');
}

// ========== PORT & SERVER CHECK ==========
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/server-info`, { timeout: 2000 }, () => resolve(true));
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
async function findServerPort(): Promise<number> {
  if (await isTcpPortFree(SERVER_PORT)) return SERVER_PORT;
  if (await isPortInUse(SERVER_PORT)) {
    console.log(`[Electron] Port ${SERVER_PORT} already active — reusing existing.`);
    return SERVER_PORT;
  }
  for (let p = SERVER_PORT + 1; p <= SERVER_PORT + 50; p++) {
    if (await isTcpPortFree(p)) {
      console.log(`[Electron] Port ${SERVER_PORT} occupied → using port ${p} for backend.`);
      return p;
    }
  }
  console.error(`[Electron] Fatal: no free port found near ${SERVER_PORT}.`);
  return SERVER_PORT;
}

function waitForServer(port: number, timeoutMs: number = 30000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/server-info`, { timeout: 2000 }, () => resolve(true));
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(poll, 500);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
    };
    poll();
  });
}

// Khởi chạy server: Chạy trực tiếp in-process (Packaged) hoặc spawn tsx (Dev)
async function startServerInProcessOrDev(): Promise<void> {
  const projectRoot = getProjectRoot();
  process.env.PORT = String(SERVER_PORT);

  // 1. Packaged Mode: Import và chạy trực tiếp IN-PROCESS trong Electron main process
  if (!isDev()) {
    console.log(`[Electron] Packaged mode: Starting backend IN-PROCESS on port ${SERVER_PORT}...`);
    const candidateServerPaths = [
      path.join(__dirname, '..', 'dist', 'server.js'),
      path.join(__dirname, 'server.js'),
      path.join(process.resourcesPath, 'app.asar', 'dist', 'server.js'),
      path.join(process.resourcesPath, 'app', 'dist', 'server.js'),
      path.join(projectRoot, 'dist', 'server.js')
    ];

    let loaded = false;
    for (const sPath of candidateServerPaths) {
      if (fs.existsSync(sPath)) {
        try {
          console.log(`[Electron] Dynamic importing backend from: ${sPath}`);
          const fileUrl = pathToFileURL(sPath).href;
          await import(fileUrl);
          console.log(`[Electron] Backend server loaded and running in-process on port ${SERVER_PORT}`);
          loaded = true;
          break;
        } catch (err: any) {
          console.error(`[Electron] Failed to import backend from ${sPath}:`, err?.message || err);
        }
      }
    }

    if (!loaded) {
      // Fallback: thử import tương đối trực tiếp
      try {
        console.log(`[Electron] Fallback importing '../dist/server.js'...`);
        await import('../dist/server.js' as any);
        console.log(`[Electron] Backend server loaded via fallback relative import on port ${SERVER_PORT}`);
      } catch (err: any) {
        console.error('[Electron] Fallback in-process backend import failed:', err?.message || err);
      }
    }
    return;
  }

  // 2. Development Mode: Spawn tsx src/server.ts nếu đang phát triển
  console.log(`[Electron] Dev mode: Starting backend server on port ${SERVER_PORT}...`);
  const tsxBin = path.join(projectRoot, 'node_modules', '.bin', 'tsx');
  const hasTsx = fs.existsSync(tsxBin) || fs.existsSync(tsxBin + '.cmd');

  if (hasTsx) {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? (fs.existsSync(tsxBin + '.cmd') ? tsxBin + '.cmd' : 'cmd.exe') : tsxBin;
    const args = isWin && !fs.existsSync(tsxBin + '.cmd') ? ['/c', 'npx', 'tsx', 'src/server.ts'] : ['src/server.ts'];

    try {
      serverProcess = spawn(cmd, args, {
        cwd: projectRoot,
        env: { ...process.env, PORT: String(SERVER_PORT) },
        stdio: 'pipe',
        windowsHide: true
      });

      serverProcess.stdout?.on('data', (d) => console.log(`[Server] ${d.toString().trim()}`));
      serverProcess.stderr?.on('data', (d) => console.error(`[Server] ${d.toString().trim()}`));
      serverProcess.on('error', (err) => {
        console.error('[Electron] Dev server spawn error:', err.message);
        serverProcess = null;
      });
      serverProcess.on('exit', (code) => {
        console.log(`[Electron] Dev server exited (code ${code})`);
        serverProcess = null;
      });
    } catch (e: any) {
      console.error('[Electron] Failed to spawn dev server:', e?.message || e);
    }
  } else {
    // Dev fallback: in-process import
    try {
      const serverPath = path.join(projectRoot, 'dist', 'server.js');
      if (fs.existsSync(serverPath)) {
        await import(pathToFileURL(serverPath).href);
      } else {
        await import('../dist/server.js' as any);
      }
    } catch (e: any) {
      console.error('[Electron] Dev fallback in-process import error:', e?.message || e);
    }
  }
}

async function ensureServerRunning(): Promise<void> {
  const resolvedPort = await findServerPort();
  const alreadyRunning = await isPortInUse(resolvedPort);
  SERVER_PORT = resolvedPort;

  if (alreadyRunning) {
    console.log(`[Electron] Port ${SERVER_PORT} already active — reusing existing.`);
    return;
  }

  await startServerInProcessOrDev();
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

  const serverUrl = `http://127.0.0.1:${SERVER_PORT}`;
  console.log(`[Electron] Loading UI from: ${serverUrl}`);

  mainWindow.loadURL(serverUrl).catch(() => {
    console.warn(`[Electron] Failed to load server URL directly, retrying in 1s...`);
    setTimeout(() => {
      mainWindow?.loadURL(serverUrl).catch((e) => {
        console.error('[Electron] Failed to load app:', e);
      });
    }, 1000);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ========== CLEANUP ==========
function cleanup(): void {
  if (serverProcess) {
    console.log('[Electron] Shutting down backend server process...');
    try {
      if (process.platform === 'win32' && serverProcess.pid) {
        spawn('taskkill', ['/pid', serverProcess.pid.toString(), '/f', '/t'], { stdio: 'ignore' });
      } else {
        serverProcess.kill('SIGTERM');
        setTimeout(() => {
          try { serverProcess?.kill('SIGKILL'); } catch {}
        }, 3000);
      }
    } catch (e) {
      console.error('[Electron] Kill error:', e);
    }
    serverProcess = null;
  }
}

// ========== APP LIFECYCLE ==========
app.on('ready', async () => {
  console.log(`[Electron] Mode: ${isDev() ? 'development' : 'production'}`);

  // 1. Ensure backend is running (in-process for packaged)
  await ensureServerRunning();

  // 2. Wait until backend responds
  console.log(`[Electron] Waiting for server on port ${SERVER_PORT}...`);
  const ready = await waitForServer(SERVER_PORT, 30000);
  if (!ready) {
    console.warn(`[Electron] Server not responding after 30s — opening window anyway.`);
  }

  // 3. Create browser window
  createWindow();
});

app.on('window-all-closed', () => {
  cleanup();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', cleanup);

// ========== IPC ==========
ipcMain.handle('get-port', () => SERVER_PORT);
ipcMain.handle('is-dev', () => isDev());
