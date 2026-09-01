const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

let mainWindow = null;
let serverProcess = null;
const SERVER_PORT = 3001;
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1')
      .on('listening', () => {
        server.close(() => resolve(true));
      })
      .on('error', () => resolve(false));
  });
}

async function startServer() {
  const available = await isPortAvailable(SERVER_PORT);
  if (available) {
    console.log(`[Electron] Starting backend server on port ${SERVER_PORT}...`);
    const projectRoot = path.join(__dirname, '..');
    const isWin = process.platform === 'win32';
    
    // Spawn tsx src/server.ts or start.bat
    serverProcess = spawn(
      isWin ? 'cmd.exe' : 'sh',
      isWin ? ['/c', 'npx tsx src/server.ts'] : ['-c', 'npx tsx src/server.ts'],
      {
        cwd: projectRoot,
        env: { ...process.env, PORT: SERVER_PORT.toString() },
        stdio: 'pipe'
      }
    );

    serverProcess.stdout?.on('data', (data) => console.log(`[Server] ${data.toString()}`));
    serverProcess.stderr?.on('data', (data) => console.error(`[Server Error] ${data.toString()}`));
  } else {
    console.log(`[Electron] Port ${SERVER_PORT} is already active.`);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f172a', // Slate-900 Dark Mode
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    },
    autoHideMenuBar: true,
    show: false
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (process.env.NODE_ENV === 'development' && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
    mainWindow.loadFile(indexPath);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function cleanup() {
  if (serverProcess) {
    console.log('[Electron] Shutting down backend server...');
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', serverProcess.pid.toString(), '/f', '/t']);
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch (e) {
      console.error('[Electron] Error during cleanup:', e);
    }
    serverProcess = null;
  }
}

app.on('ready', async () => {
  await startServer();
  setTimeout(createWindow, 600);
});

app.on('window-all-closed', () => {
  cleanup();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', cleanup);

// IPC Handlers
ipcMain.handle('get-server-port', () => SERVER_PORT);
