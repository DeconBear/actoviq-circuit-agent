/**
 * Runner for the schematic-editor Playwright scenes.
 *
 * Usage:
 *   node scripts/e2e/run-schematic-editor.mjs                  # run all scenes
 *   node scripts/e2e/run-schematic-editor.mjs --scene=gnd      # run a single scene
 *   node scripts/e2e/run-schematic-editor.mjs --scene=gnd,legacy  # run selected scenes
 *   node scripts/e2e/run-schematic-editor.mjs --shard=1/3      # run shard 1 of 3
 *
 * Scene names match the shouldRun() gates in playwright-schematic-editor-smoke.mjs:
 *   filter-editor, legacy, junction, unconnected, gnd, params
 *
 * Each run writes artifacts under output/playwright/ with a per-scene tag in the
 * workspace path so parallel shards do not collide.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const smokeScript = path.resolve(root, 'scripts', 'playwright-schematic-editor-smoke.mjs');

const ALL_SCENES = ['filter-editor', 'legacy', 'junction', 'unconnected', 'gnd', 'params'];

function parseArgs(argv) {
  const args = { scene: null, shard: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--scene=')) {
      args.scene = arg.slice('--scene='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--shard=')) {
      const [index, total] = arg.slice('--shard='.length).split('/').map((n) => Number.parseInt(n, 10));
      if (!Number.isFinite(index) || !Number.isFinite(total) || index < 1 || total < 1 || index > total) {
        throw new Error(`Invalid --shard value: ${arg} (expected n/total with 1 <= n <= total)`);
      }
      args.shard = { index, total };
    }
  }
  return args;
}

function selectScenes(args) {
  if (args.scene) {
    const unknown = args.scene.filter((name) => !ALL_SCENES.includes(name));
    if (unknown.length > 0) {
      throw new Error(`Unknown scene(s): ${unknown.join(', ')}. Available: ${ALL_SCENES.join(', ')}`);
    }
    return args.scene;
  }
  if (args.shard) {
    const { index, total } = args.shard;
    const bucket = [];
    for (let i = 0; i < ALL_SCENES.length; i += 1) {
      if (i % total === index - 1) bucket.push(ALL_SCENES[i]);
    }
    return bucket;
  }
  return null;
}

async function runScenes(scenes) {
  const env = { ...process.env };
  if (scenes) {
    env.ACTOVIQ_E2E_SCENES = scenes.join(',');
    // Single-scene runs get a per-scene artifact directory so parallel shards
    // and repeated single-scene runs do not overwrite each other's screenshots.
    if (scenes.length === 1) {
      env.ACTOVIQ_E2E_SCENE_TAG = scenes[0];
    }
  }
  const child = spawn(process.execPath, [smokeScript], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => {
      if (code === 0) resolve(code);
      else reject(new Error(`schematic-editor scenes exited with code ${code}`));
    });
    child.once('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const scenes = selectScenes(args);
  if (scenes) {
    console.log(`[runner] running scenes: ${scenes.join(', ')}`);
  } else {
    console.log(`[runner] running all scenes: ${ALL_SCENES.join(', ')}`);
  }
  try {
    await runScenes(scenes);
  } catch (error) {
    console.error(`[runner] ${error.message}`);
    process.exit(1);
  }
}

await main();
