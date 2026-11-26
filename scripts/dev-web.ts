import { spawn } from 'node:child_process';

const folderArg = process.argv[2] || '';
const env = {
  ...process.env,
  PHOTOCULL_PORT: process.env.PHOTOCULL_PORT || '4174',
  ...(folderArg ? { PHOTOCULL_FOLDER: folderArg } : {}),
};

const serverProc = spawn('bun', ['--watch', 'server/index.ts'], { stdio: 'inherit', env });
const viteProc = spawn('bunx', ['vite', '--host', '127.0.0.1'], { stdio: 'inherit', env });

const cleanup = () => {
  serverProc.kill();
  viteProc.kill();
  process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
