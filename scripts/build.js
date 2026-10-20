// Compiles Splice into standalone executables with Bun (no Node needed to run them).
//   bun scripts/build.js                 this machine's platform
//   bun scripts/build.js --all           every release target
//   bun scripts/build.js bun-linux-x64   specific targets
// Output goes to dist/.
import pkg from '../package.json' with { type: 'json' };

const TARGETS = {
  'bun-windows-x64': 'splice-windows-x64.exe',
  'bun-linux-x64': 'splice-linux-x64',
  'bun-linux-arm64': 'splice-linux-arm64',
  'bun-darwin-x64': 'splice-macos-x64',
  'bun-darwin-arm64': 'splice-macos-arm64',
};

const args = process.argv.slice(2);
const here = `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const targets = args.includes('--all') ? Object.keys(TARGETS) : args.length ? args : [here];

// Ink only loads react-devtools-core when DEV=true, but the bundler still wants to resolve it.
const noDevtools = {
  name: 'no-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default { connectToDevTools() {} };', loader: 'js' }));
  },
};

for (const target of targets) {
  if (!TARGETS[target]) throw new Error(`Unknown target ${target}. Known: ${Object.keys(TARGETS).join(', ')}`);
  const outfile = `dist/${TARGETS[target]}`;
  // Knot as the .exe icon. Bun can only write it when building on Windows, so CI builds that target there.
  const windows = target.includes('windows') && process.platform === 'win32' ? { icon: 'assets/knot.ico', title: 'Splice' } : undefined;
  const result = await Bun.build({
    entrypoints: ['src/cli.jsx'],
    compile: { target, outfile, windows },
    minify: true,
    plugins: [noDevtools],
    // NODE_ENV picks React's production build; defined in the bundle, it never reaches git's environment.
    define: { 'process.env.SPLICE_VERSION': JSON.stringify(pkg.version), 'process.env.NODE_ENV': '"production"' },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`${target} → ${outfile}`);
}
