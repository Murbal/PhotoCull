import type { BunPlugin } from 'bun';

const externalElectronPlugin: BunPlugin = {
  name: 'external-electron',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({
      path: 'electron',
      external: true,
    }));
  },
};

const mainBuild = await Bun.build({
  entrypoints: ['electron/main.ts'],
  outdir: 'dist-electron',
  naming: 'main.cjs',
  target: 'node',
  format: 'cjs',
  plugins: [externalElectronPlugin],
});

if (!mainBuild.success) {
  for (const log of mainBuild.logs) console.error(log);
  process.exit(1);
}

const preloadBuild = await Bun.build({
  entrypoints: ['electron/preload.ts'],
  outdir: 'dist-electron',
  naming: 'preload.cjs',
  target: 'node',
  format: 'cjs',
  plugins: [externalElectronPlugin],
});

if (!preloadBuild.success) {
  for (const log of preloadBuild.logs) console.error(log);
  process.exit(1);
}

console.log('Built dist-electron/main.cjs and dist-electron/preload.cjs');
