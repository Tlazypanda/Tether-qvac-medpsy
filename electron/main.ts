// Conduit desktop shell — Electron main process.
//
// Electron's main process IS Node, so the heavy native engine (src/web/server.ts: QVAC Bare worker,
// GPU, rocksdb, WDK) runs verbatim as a CHILD process. This file is purely a lifecycle manager:
//   spawn engine → wait until /api/wallet answers → open a BrowserWindow on it → kill it cleanly on quit.
//
// M3a is DEV-ONLY: the engine runs from source via `node --import tsx src/web/server.ts`. Packaged mode
// (a compiled engine spawned with Electron's bundled Node) is M3c — see engineSpawnSpec() for the seam.
import { app, BrowserWindow, shell, ipcMain, safeStorage } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

// electron/dist/main.js → repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PORT_PREF = Number(process.env.PORT) || 8788;
const READY_TIMEOUT_MS = 90_000; // engine boot can include first model warm-up; be patient
const SHUTDOWN_GRACE_MS = 8_000; // give the engine time to stop the Bare worker before we SIGKILL

// Escrow (instant payment-channel) is ON by default in the shipped app — paid answers settle off-chain
// in ~2s instead of waiting ~15s on-chain each time. The contract is deployed on Sepolia; the address
// is public (not a secret). Passed via env so it works in both packaged and dev electron runs without
// bundling deployed.sepolia.json. (Keep in sync with contracts/deployed.sepolia.json if redeployed.)
const ESCROW_ENV: NodeJS.ProcessEnv = {
  CONDUIT_ESCROW: '1',
  CONDUIT_ESCROW_ADDRESS: '0x741BbE3B2d19E1aE965467280Cc2a442F3632Ee7',
  CONDUIT_CHAIN_ID: '11155111',
};

let engine: ChildProcess | null = null;
let win: BrowserWindow | null = null;
let quitting = false;

// ---------- port selection (honor PORT, else find a free one; handles "port in use") ----------
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort(): Promise<number> {
  // If PORT is explicitly set, respect it and don't second-guess.
  if (process.env.PORT) return PORT_PREF;
  for (let p = PORT_PREF; p < PORT_PREF + 20; p++) {
    if (await isPortFree(p)) return p;
  }
  // Fall back to an ephemeral free port.
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : PORT_PREF;
      srv.close(() => resolve(port));
    });
  });
}

// ---------- engine spawn spec (the dev/packaged seam) ----------
function engineSpawnSpec(): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  if (app.isPackaged) {
    // M3c packaged: run the compiled engine bundle with Electron's bundled Node. cwd is the
    // unpacked app dir so the engine resolves native node_modules (bare-runtime, rocksdb, @qvac/sdk)
    // by normal walk-up, and finds app/dist + bench-profile.json via CONDUIT_RESOURCES.
    const resourcesApp = path.join(process.resourcesPath, 'app');
    return {
      command: process.execPath,
      args: [path.join(resourcesApp, 'dist-engine', 'server.mjs')],
      cwd: resourcesApp,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        CONDUIT_RESOURCES: resourcesApp,
        CONDUIT_SELLER_ENTRY: path.join(resourcesApp, 'dist-engine', 'sell.mjs'),
        ...ESCROW_ENV,
      },
    };
  }
  // Dev: run the engine from source with tsx. `node` comes from the launching shell's PATH.
  return {
    command: process.platform === 'win32' ? 'node.exe' : 'node',
    args: ['--import', 'tsx', 'src/web/server.ts'],
    cwd: REPO_ROOT,
    env: { ...ESCROW_ENV },
  };
}

function startEngine(port: number): ChildProcess {
  const spec = engineSpawnSpec();
  console.log(`[shell] starting engine: ${spec.command} ${spec.args.join(' ')} (PORT=${port})`);
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so we can kill the engine AND its grandchildren (Bare worker / seller),
    // which otherwise leak and hold GPU memory (handoff gotcha #6). Not supported on Windows.
    detached: process.platform !== 'win32',
  });
  child.stdout?.on('data', (b) => process.stdout.write(`[engine] ${b}`));
  child.stderr?.on('data', (b) => process.stderr.write(`[engine] ${b}`));
  child.on('exit', (code, signal) => {
    console.log(`[shell] engine exited (code=${code} signal=${signal})`);
    engine = null;
    if (!quitting) {
      // The engine died on its own — nothing to show. Tear the app down.
      app.quit();
    }
  });
  return child;
}

// ---------- readiness probe: poll /api/wallet until the engine answers ----------
function pingWallet(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/wallet', timeout: 2_000 }, (res) => {
      res.resume(); // drain
      resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForEngine(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (engine === null) throw new Error('engine process exited before becoming ready');
    if (await pingWallet(port)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`engine did not become ready within ${READY_TIMEOUT_MS / 1000}s`);
}

// ---------- graceful shutdown: SIGTERM the group → wait → SIGKILL ----------
async function stopEngine(): Promise<void> {
  const child = engine;
  if (!child || child.pid == null) return;
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  // Kill the whole process group (negative pid) so the Bare worker dies too; fall back to the pid.
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }

  const timer = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SHUTDOWN_GRACE_MS));
  const result = await Promise.race([exited.then(() => 'exited' as const), timer]);
  if (result === 'timeout') {
    console.log('[shell] engine did not exit in time — SIGKILL');
    try {
      if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* already gone */ }
  }
  engine = null;
}

// ---------- window ----------
function createWindow(url: string): void {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#0E1217', // matches the app's ink background — no white flash on load
    title: 'MedConsult',
    icon: path.join(__dirname, 'icon.png'), // taskbar / window icon (Linux & Windows; macOS uses the .icns)
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // Open external links (faucets, explorer) in the system browser, not inside the app window.
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith('http://') || u.startsWith('https://')) void shell.openExternal(u);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
  void win.loadURL(url);
}

// ---------- "remember on this device" (OS keychain via safeStorage) ----------
// The wallet password stays the primary lock; this optionally caches it, OS-encrypted, so the
// renderer can offer auto-unlock. The plaintext password never touches disk — only safeStorage's
// keychain-backed ciphertext does. Exposed to the renderer through preload (window.conduit.secret).
function rememberPath(): string {
  return path.join(app.getPath('userData'), 'wallet-remember.bin');
}
function registerSecretIpc(): void {
  ipcMain.handle('secret:available', () => safeStorage.isEncryptionAvailable());
  ipcMain.handle('secret:set', (_e, value: string) => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    try { writeFileSync(rememberPath(), safeStorage.encryptString(String(value)), { mode: 0o600 }); return true; }
    catch { return false; }
  });
  ipcMain.handle('secret:get', () => {
    try {
      if (!existsSync(rememberPath())) return null;
      return safeStorage.decryptString(readFileSync(rememberPath()));
    } catch { return null; }
  });
  ipcMain.handle('secret:clear', () => { try { rmSync(rememberPath()); } catch { /* nothing */ } return true; });
}

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    registerSecretIpc();
    try {
      const port = await pickPort();
      engine = startEngine(port);
      await waitForEngine(port);
      createWindow(`http://127.0.0.1:${port}`);
    } catch (e: any) {
      console.error('[shell] failed to start:', e?.message ?? e);
      await stopEngine();
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    // Quit on every platform (incl. macOS): keeping the engine child alive headless wastes GPU/RAM.
    app.quit();
  });

  app.on('before-quit', (e) => {
    if (engine && !quitting) {
      quitting = true;
      e.preventDefault(); // hold the quit until the engine is down, then quit for real
      void stopEngine().finally(() => app.quit());
    } else {
      quitting = true;
    }
  });
}
