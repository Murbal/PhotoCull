import { spawn } from 'node:child_process';
import path from 'node:path';

const folderArg = process.argv[2] ? path.resolve(process.argv[2]) : '';
const electronBin = path.resolve(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);

const childEnv = { ...process.env };
// Unset ELECTRON_RUN_AS_NODE in case launched from an Electron-based IDE/terminal (VS Code, T3 Code, etc.)
delete childEnv.ELECTRON_RUN_AS_NODE;
if (folderArg) childEnv.PHOTOCULL_FOLDER = folderArg;

const args = ['.', ...(folderArg ? [folderArg] : []), ...process.argv.slice(3)];
const child = spawn(electronBin, args, {
  stdio: 'inherit',
  env: childEnv,
});

child.on('exit', (code) => process.exit(code ?? 0));
