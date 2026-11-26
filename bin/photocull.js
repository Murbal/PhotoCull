#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const folderArg = process.argv[2] ? path.resolve(process.argv[2]) : '';

const electronBin = path.join(
  rootDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);

const childEnv = {
  ...process.env,
  ...(folderArg ? { PHOTOCULL_FOLDER: folderArg } : {}),
};
delete childEnv.ELECTRON_RUN_AS_NODE;

const args = [rootDir, ...(folderArg ? [folderArg] : [])];
const child = spawn(electronBin, args, {
  cwd: rootDir,
  stdio: 'inherit',
  env: childEnv,
});

child.on('exit', (code) => process.exit(code ?? 0));
