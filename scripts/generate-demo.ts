import path from 'node:path';
import { generateDemoShoot } from '../server/demoGenerator.js';

const target = process.argv[2] || path.join(process.cwd(), 'demo-shoot');
const count = Number(process.argv[3] || 24);

const start = performance.now();
const res = await generateDemoShoot(target, count);
const elapsed = Math.round(performance.now() - start);
console.log(`Generated ${res.created} synthetic RAW/JPEG frames in ${res.folder} (${elapsed}ms)`);
