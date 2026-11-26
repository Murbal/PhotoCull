import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

function hasCommand(cmd: string): boolean {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    stdio: 'ignore',
  });
  return res.status === 0;
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

const extraArgs = process.argv.slice(2);
const isWindowsHost = process.platform === 'win32';
const hasWine = !isWindowsHost && (hasCommand('wine') || hasCommand('wine64'));
const hasExplicitTarget = extraArgs.some((a) => !a.startsWith('-'));
const wantsDirOnly = extraArgs.includes('--dir');
const wantsWineTarget = extraArgs.some((a) => a === 'nsis' || a === 'portable');

if (!isWindowsHost && !hasWine && wantsWineTarget) {
  console.error(
    '[package:win] Error: Windows "nsis" and "portable" targets require running on Windows or having Wine installed on Linux/macOS.',
  );
  console.error(
    '[package:win] Run "bun run package:win" (or "bun run package:win:zip") to build a ready-to-run Windows .zip + PhotoCull.exe without Wine.',
  );
  process.exit(1);
}

// 1. Build frontend & Electron main/preload bundles
const buildCode = await run('bun', ['run', 'build']);
if (buildCode !== 0) {
  process.exit(buildCode);
}

// 2. Run electron-builder targeting Windows x64
const ebBin = path.resolve(
  process.cwd(),
  'node_modules',
  '.bin',
  isWindowsHost ? 'electron-builder.cmd' : 'electron-builder',
);

const ebArgs: string[] = ['--win'];

if (!isWindowsHost && !hasWine && !hasExplicitTarget && !wantsDirOnly) {
  // Cross-building on Linux/WSL2/macOS without Wine: build portable zip + win-unpacked/PhotoCull.exe
  console.log(
    '[package:win] Wine not detected on non-Windows host — building Windows x64 zip + win-unpacked/PhotoCull.exe.',
  );
  console.log(
    '[package:win] (For NSIS installer / single-file portable .exe, run "bun run package:win" on Windows or install Wine.)',
  );
  ebArgs.push('zip');
}

ebArgs.push('--x64', ...extraArgs);

if (!isWindowsHost && !hasWine) {
  ebArgs.push('-c.win.signAndEditExecutable=false');
}

const ebCode = await run(ebBin, ebArgs);
process.exit(ebCode);
