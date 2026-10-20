// Shared by the tests that make throwaway repositories. Import it before anything from src/: git.js
// copies the environment when it loads, and the setting below has to be in it.
import { rm } from 'node:fs/promises';

// Git's automatic housekeeping (gc, maintenance) can start in the background after a commit and keep a
// throwaway repository's folder busy on Windows long after its test is done. These repositories don't need it.
// Set through the environment, so it reaches both the tests' own git and the git Splice runs, and never
// touches anyone's real git config.
const settings = { 'gc.auto': '0', 'maintenance.auto': 'false' };
let n = Number(process.env.GIT_CONFIG_COUNT) || 0;
for (const [key, value] of Object.entries(settings)) {
  process.env[`GIT_CONFIG_KEY_${n}`] = key;
  process.env[`GIT_CONFIG_VALUE_${n}`] = value;
  n++;
}
process.env.GIT_CONFIG_COUNT = String(n);

/**
 * Removes a test's temp folder. On Windows a git still finishing for an unmounted app can hold it for a
 * while, so it retries, and then leaves it: a leftover temp folder is harmless, a failed suite isn't.
 */
export async function removeTemp(dir) {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (e) {
    if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'ENOTEMPTY') throw e;
  }
}
