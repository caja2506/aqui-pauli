import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const origin = 'https://aqui-pauli.web.app';
const expectedRelease = JSON.parse(await readFile('dist/deployment.json', 'utf8'));
assert.match(expectedRelease.commit, /^[a-f0-9]{40}$/);
assert.equal(expectedRelease.repository, 'caja2506/aqui-pauli');

const index = await readFile('dist/index.html');
const assets = [...new Set(
  [...index.toString().matchAll(/(?:src|href)=["'](\/assets\/[^"']+\.(?:js|css))["']/g)]
    .map((match) => match[1]),
)];
assert(assets.some((path) => path.endsWith('.js')), 'No JavaScript entry point in the build');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const expectedFiles = new Map([['/', index]]);
for (const path of assets) {
  assert(!path.includes('..'), 'Invalid asset path');
  expectedFiles.set(path, await readFile(`dist${path}`));
}

async function get(path) {
  const url = new URL(path, origin);
  url.searchParams.set('verify', expectedRelease.commit);
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, `${path}: expected HTTP 200`);
  return response;
}

for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    assert.deepEqual(await (await get('/deployment.json')).json(), expectedRelease,
      'The public version does not match the requested commit');
    for (const [path, expected] of expectedFiles) {
      const actual = Buffer.from(await (await get(path)).arrayBuffer());
      assert.equal(hash(actual), hash(expected), `${path}: published content differs from the build`);
    }
    for (const path of ['/catalogo', '/carrito']) {
      const route = await get(path);
      assert.equal(hash(Buffer.from(await route.arrayBuffer())), hash(index),
        `${path} does not serve the single-page app`);
    }
    console.log(`Verified ${origin}: commit ${expectedRelease.commit}, index, ${assets.length} assets, /catalogo and /carrito.`);
    break;
  } catch (error) {
    if (attempt === 5) throw error;
    console.warn(`Verification attempt ${attempt}: ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
