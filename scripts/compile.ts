// Builds standalone `poker-lan` executables with Bun: the JavaScript runtime, the game and its
// assets in one file, so players don't need Node or npm.
//
//   bun scripts/compile.ts                      → bin/poker-lan for this machine
//   bun scripts/compile.ts linux-x64 darwin-arm64 …  → release/poker-lan-<target>[.exe]
//
// Run `npm run embed` (or `make`) first so src/generated/assets.ts exists.

const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'] as const;

// Ink can talk to React DevTools when DEV=true. We never do, so swap that package for an empty
// stand-in instead of bundling it (it isn't installed, and the executable would fail to start).
const noDevtools: import('bun').BunPlugin = {
  name: 'no-react-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} };',
      loader: 'js',
    }));
  },
};

async function compile(target: string | null): Promise<string> {
  const outfile = target ? `release/poker-lan-${target}${target.startsWith('windows') ? '.exe' : ''}` : 'bin/poker-lan';
  const result = await Bun.build({
    entrypoints: ['src/cli.tsx'],
    compile: target ? { target: `bun-${target}` as Bun.Build.Target, outfile } : { outfile },
    minify: true,
    plugins: [noDevtools],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed for ${target ?? 'this machine'}`);
  }
  return outfile;
}

const requested = process.argv.slice(2);
for (const target of requested) {
  if (!(TARGETS as readonly string[]).includes(target)) {
    console.error(`Unknown target "${target}". Choose from: ${TARGETS.join(', ')}`);
    process.exit(1);
  }
}
for (const target of requested.length ? requested : [null]) {
  console.log(`built ${await compile(target)}`);
}
