import { spawn } from 'node:child_process';
import path from 'node:path';

const folderArg = process.argv[2] ? path.resolve(process.argv[2]) : '';
const VITE_PORT = 5173;
const DEV_URL = `http://127.0.0.1:${VITE_PORT}`;

async function buildElectron(): Promise<void> {
  const proc = spawn('bun', ['run', 'build:electron'], { stdio: 'inherit' });
  const code = await new Promise<number | null>((resolve) => proc.on('exit', resolve));
  if (code !== 0) {
    throw new Error(`Electron main/preload build failed with exit code ${code}`);
  }
}

async function waitForUrl(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for Vite dev server at ${url}`);
}

await buildElectron();

const viteProc = spawn('bunx', ['vite', '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], {
  stdio: 'inherit',
});

let electronProc: ReturnType<typeof spawn> | null = null;

const cleanup = (exitCode = 0) => {
  if (electronProc && !electronProc.killed) electronProc.kill();
  if (!viteProc.killed) viteProc.kill();
  process.exit(exitCode);
};

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

try {
  await waitForUrl(DEV_URL);

  const electronBin = path.resolve(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron.cmd' : 'electron',
  );

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    VITE_DEV_SERVER_URL: DEV_URL,
    ...(folderArg ? { PHOTOCULL_FOLDER: folderArg } : {}),
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const electronArgs = ['.', ...(folderArg ? [folderArg] : [])];
  electronProc = spawn(electronBin, electronArgs, {
    stdio: 'inherit',
    env: childEnv,
  });

  electronProc.on('exit', (code) => cleanup(code ?? 0));
  viteProc.on('exit', (code) => {
    if (code && code !== 0) cleanup(code);
  });
} catch (err) {
  console.error(err);
  cleanup(1);
}
