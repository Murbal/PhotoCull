import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function hasCommand(cmd: string): boolean {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    stdio: 'ignore',
  });
  return res.status === 0;
}

function run(cmd: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd });
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
// Under WSL without Wine, NSIS/portable targets are built by the Windows host's Node instead.
const useWindowsHost = !hasWine && isWsl() && !wantsDirOnly && (!hasExplicitTarget || wantsWineTarget);

if (!isWindowsHost && !hasWine && !useWindowsHost && wantsWineTarget) {
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

if (useWindowsHost) {
  process.exit(await packageOnWindowsHost());
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

// electron-builder needs Wine on Linux to build the NSIS installer and portable .exe.
// Under WSL, copy the built app to the Windows temp dir, run electron-builder there with the
// host's Node (npx), and copy the installers back into release/.
async function packageOnWindowsHost(): Promise<number> {
  const root = process.cwd();
  const versionOf = (pkg: string): string =>
    JSON.parse(readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version;

  // cmd.exe refuses a \\wsl.localhost cwd, so start it from /mnt/c.
  const winTemp = execFileSync('cmd.exe', ['/d', '/c', 'echo %TEMP%'], { cwd: '/mnt/c', encoding: 'utf8' }).trim();
  const stage = path.join(execFileSync('wslpath', ['-u', winTemp], { encoding: 'utf8' }).trim(), 'photocull-package');
  console.log(`[package:win] WSL detected — building on the Windows host in ${stage}`);

  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const dir of ['dist', 'dist-electron']) {
    cpSync(path.join(root, dir), path.join(stage, dir), { recursive: true });
  }
  // Everything the app loads at runtime is bundled into dist/ and dist-electron/, and the host
  // has no node_modules, so ship a package.json without dependencies.
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  delete pkg.dependencies;
  delete pkg.devDependencies;
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2));

  const code = await run(
    'cmd.exe',
    [
      '/d',
      '/c',
      'npx.cmd',
      '-y',
      `electron-builder@${versionOf('electron-builder')}`,
      '--win',
      '--x64',
      ...extraArgs,
      `-c.electronVersion=${versionOf('electron')}`,
    ],
    stage,
  );
  if (code !== 0) return code;

  const from = path.join(stage, 'release');
  const to = path.join(root, 'release');
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name.endsWith('.exe') || name.endsWith('.blockmap')) {
      cpSync(path.join(from, name), path.join(to, name));
      console.log(`[package:win] Copied release/${name}`);
    }
  }
  rmSync(stage, { recursive: true, force: true });
  return 0;
}
