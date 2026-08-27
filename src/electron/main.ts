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

// ========== MULTI-TIER BACKEND RUNNER ==========
// 1. Ưu tiên 1: Spawn binary sidecar agentforge-web.exe (trong resourcesPath hoặc cạnh process.execPath)
// 2. Ưu tiên 2: In-process dynamic import (dist/server.js) hoặc spawn với ELECTRON_RUN_AS_NODE=1
// 3. Ưu tiên 3: Dev mode spawn tsx
function findBackendRunner(): { type: 'spawn' | 'in-process'; cmd?: string; args?: string[]; env?: Record<string, string>; cwd?: string; scriptPath?: string } | null {
  const projectRoot = getProjectRoot();

  // 1. Ưu tiên 1: Tìm binary standalone agentforge-web.exe
  const candidateExePaths = [
    path.join(process.resourcesPath, 'agentforge-web.exe'),
    path.join(process.resourcesPath, 'app', 'agentforge-web.exe'),
    path.join(path.dirname(process.execPath), 'agentforge-web.exe'),
    path.join(process.cwd(), 'release', 'agentforge-web.exe'),
    path.join(process.cwd(), 'agentforge-web.exe')
  ];

  for (const exePath of candidateExePaths) {
    if (fs.existsSync(exePath)) {
      console.log(`[Electron] [Tier 1] Found standalone sidecar binary: ${exePath}`);
      return {
        type: 'spawn',
        cmd: exePath,
        args: [],
        cwd: path.dirname(exePath)
      };
    }
  }

  // 2. Ưu tiên 2: Packaged mode in-process / Node runner
  if (!isDev()) {
    const candidateJsPaths = [
      path.join(__dirname, '..', 'dist', 'server.js'),
      path.join(__dirname, 'server.js'),
      path.join(process.resourcesPath, 'app.asar', 'dist', 'server.js'),
      path.join(process.resourcesPath, 'app', 'dist', 'server.js'),
      path.join(projectRoot, 'dist', 'server.js')
    ];

    for (const jsPath of candidateJsPaths) {
      if (fs.existsSync(jsPath)) {
        console.log(`[Electron] [Tier 2] Found packaged backend script: ${jsPath}`);
        return {
          type: 'in-process',
          scriptPath: jsPath,
          cmd: process.execPath,
          args: [jsPath],
          env: { ELECTRON_RUN_AS_NODE: '1' },
          cwd: projectRoot
        };
      }
    }
  }

  // 3. Ưu tiên 3: Dev mode: dùng tsx nếu có
  if (isDev()) {
    const tsxBin = path.join(projectRoot, 'node_modules', '.bin', 'tsx');
    if (fs.existsSync(tsxBin) || fs.existsSync(tsxBin + '.cmd')) {
      console.log(`[Electron] [Tier 3] Found dev tsx runner at: ${tsxBin}`);
      return {
        type: 'spawn',
        cmd: process.platform === 'win32' ? (fs.existsSync(tsxBin + '.cmd') ? tsxBin + '.cmd' : 'cmd.exe') : tsxBin,
        args: process.platform === 'win32' && !fs.existsSync(tsxBin + '.cmd') ? ['/c', 'npx', 'tsx', 'src/server.ts'] : ['src/server.ts'],
        cwd: projectRoot
      };
    }
  }

  return null;
}

async function ensureServerRunning(): Promise<void> {
  const resolvedPort = await findServerPort();
  const alreadyRunning = await isPortInUse(resolvedPort);
  SERVER_PORT = resolvedPort;
  process.env.PORT = String(SERVER_PORT);

  if (alreadyRunning) {
    console.log(`[Electron] Port ${SERVER_PORT} already running our server — reusing existing.`);
    return;
  }

  console.log(`[Electron] Starting backend server on port ${SERVER_PORT}...`);

  const runner = findBackendRunner();
  if (!runner) {
    console.warn('[Electron] Could not locate backend runner. Attempting in-process fallback import...');
    try {
      await import('../dist/server.js' as any);
      console.log(`[Electron] In-process fallback import succeeded.`);
    } catch (e: any) {
      console.error('[Electron] In-process fallback import failed:', e?.message || e);
    }
    return;
  }

  // Thực thi theo loại runner tìm thấy
  if (runner.type === 'in-process' && runner.scriptPath) {
    try {
      console.log(`[Electron] Running backend in-process via dynamic import: ${runner.scriptPath}`);
      const fileUrl = pathToFileURL(runner.scriptPath).href;
      await import(fileUrl);
      console.log(`[Electron] In-process backend server successfully loaded.`);
      return;
    } catch (importErr: any) {
      console.warn(`[Electron] In-process import failed (${importErr?.message}). Falling back to ELECTRON_RUN_AS_NODE spawn...`);
      // Fallback sang spawn với ELECTRON_RUN_AS_NODE
    }
  }

  // Spawn subprocess (Sidecar binary, ELECTRON_RUN_AS_NODE, hoặc dev tsx)
  if (runner.cmd) {
    try {
      const spawnEnv = {
        ...process.env,
        PORT: String(SERVER_PORT),
        ...(runner.env || {})
      };

      serverProcess = spawn(runner.cmd, runner.args || [], {
        cwd: runner.cwd || getProjectRoot(),
        env: spawnEnv,
        stdio: 'pipe',
        windowsHide: true
      });

      serverProcess.stdout?.on('data', (d) => console.log(`[Server] ${d.toString().trim()}`));
      serverProcess.stderr?.on('data', (d) => console.error(`[Server] ${d.toString().trim()}`));

      serverProcess.on('error', (err) => {
        console.error('[Electron] Subprocess spawn error:', err.message);
        serverProcess = null;
      });

      serverProcess.on('exit', (code) => {
        console.log(`[Electron] Server subprocess exited (code ${code})`);
        serverProcess = null;
      });
    } catch (err: any) {
      console.error('[Electron] Exception while spawning server process:', err?.message || err);
      serverProcess = null;
    }
  }
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

  // 1. Ensure backend is running
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
