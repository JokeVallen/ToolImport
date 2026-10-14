/**
 * Test mirror failover.
 *
 * The interesting behaviour is not "it tries the second host", it is WHEN it refuses to. A
 * 404 means the registry answered and does not have that file; asking a second host the same
 * question cannot change the answer, and doing it anyway would turn a clear "missing artifact"
 * into a slow, vague failure. These tests pin both directions.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createSource, MirroredRegistrySource } from '../src/source.js';

const PRIMARY = 'https://primary.example/registry';
const MIRROR = 'https://mirror.example/registry';

/**
 * A fetch stub serving a fixed table of responses, recording every request.
 *
 * A key is either a path (`/index.yaml`, the default host) or `host:path`, which pins the
 * response to one host. That distinction is the whole point here: a failover test has two hosts
 * asking for the SAME path, so a table keyed by path alone cannot say which one is dead - and a
 * test meaning "the primary cannot be reached" would quietly exercise "the primary answered",
 * which is exactly the bug this suite exists to catch.
 *
 * @param {Record<string, {status?: number, body?: string} | 'unreachable'>} table
 * @param {string} [host] the host a bare path belongs to
 */
function fetcher(table, host = 'primary.example') {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);

    const key = Object.keys(table)
      .filter((candidate) => {
        const [owner, path] = candidate.includes(':')
          ? candidate.split(':')
          : [host, candidate];
        return new URL(url).host === owner && new URL(url).pathname.endsWith(path);
      })
      .sort((a, b) => b.length - a.length)[0];
    const entry = key ? table[key] : undefined;

    if (entry === undefined || entry === 'unreachable') {
      const error = new Error('connect ECONNREFUSED');
      throw error;
    }
    const status = entry.status ?? 200;
    return {
      status,
      statusText: status === 200 ? 'OK' : 'Not Found',
      ok: status >= 200 && status < 300,
      async text() {
        return entry.body ?? '';
      },
      async arrayBuffer() {
        return Buffer.from(entry.body ?? '');
      },
    };
  };
  return { fetchImpl, calls };
}

const INDEX = `kind: index
formatVersion: '3'
tools: []
`;

test('the primary is used when it answers', async () => {
  const { fetchImpl, calls } = fetcher({ '/index.yaml': { body: INDEX } });
  const source = createSource(PRIMARY, { fetchImpl, mirrors: [MIRROR] });

  const index = await source.fetchIndex();
  assert.equal(index.kind, 'index');
  assert.equal(calls.length, 1, `expected one request, got ${calls.length}`);
  assert.ok(calls[0].startsWith(PRIMARY), calls[0]);
  assert.equal(source.originOf('index.yaml'), PRIMARY);
});

test('an unreachable primary fails over to the mirror', async () => {
  const { fetchImpl, calls } = fetcher({
    '/index.yaml': { body: INDEX },
    'dead.example:/index.yaml': 'unreachable',
    'mirror.example:/index.yaml': { body: INDEX },
  });
  const source = createSource('https://dead.example/registry', {
    fetchImpl,
    mirrors: [MIRROR],
  });

  const index = await source.fetchIndex();
  assert.equal(index.kind, 'index');
  assert.equal(calls.length, 2, `expected primary then mirror, got ${calls.length}`);
  assert.equal(source.originOf('index.yaml'), MIRROR);
  assert.ok(calls[0].includes('dead.example'), calls[0]);
  assert.ok(calls.at(-1).startsWith(MIRROR), calls.at(-1));
});

test('a 404 does NOT fail over - the registry answered', async () => {
  const { fetchImpl, calls } = fetcher({
    '/index.yaml': { body: INDEX },
    '/payloads/gone/tool.yaml': { status: 404 },
  });
  const source = createSource(PRIMARY, { fetchImpl, mirrors: [MIRROR] });

  await assert.rejects(
    () => source.fetchManifest('payloads/gone/tool.yaml'),
    (error) => error.code === 'E-NOT-FOUND',
  );

  // One request only: the mirror was never asked, because it could not have known better.
  assert.equal(calls.length, 1, `expected only the primary to be asked, got ${calls.length}`);
  assert.ok(calls[0].startsWith(PRIMARY), calls[0]);
});

test('a malformed document does NOT fail over', async () => {
  const { fetchImpl, calls } = fetcher({
    // Valid HTTP, invalid YAML - a registry that answered with something broken.
    '/index.yaml': { body: 'kind: [unclosed\n' },
  });
  const source = createSource(PRIMARY, { fetchImpl, mirrors: [MIRROR] });

  await assert.rejects(() => source.fetchIndex());
  assert.equal(calls.length, 1, `expected only the primary to be asked, got ${calls.length}`);
});

test('artifacts fail over too, and the origin is recorded per path', async () => {
  // The primary serves the index but goes dark for the artifact; the mirror serves the artifact.
  // A per-path origin is the point: one install can legitimately draw from two hosts, and the
  // receipt has to be able to say which byte came from where.
  const { fetchImpl } = fetcher({
    '/index.yaml': { body: INDEX },
    'primary.example:a-1.0.0.tgz': 'unreachable',
    'mirror.example:a-1.0.0.tgz': { body: 'artifact-bytes' },
  });
  const source = createSource(PRIMARY, { fetchImpl, mirrors: [MIRROR] });

  await source.fetchIndex();
  const bytes = await source.fetchArtifact('payloads/a/artifacts/a-1.0.0.tgz');

  assert.equal(Buffer.from(bytes).toString(), 'artifact-bytes');
  assert.equal(source.originOf('index.yaml'), PRIMARY);
  assert.equal(source.originOf('payloads/a/artifacts/a-1.0.0.tgz'), MIRROR);
});

test('when every mirror is unreachable the error names all of them', async () => {
  const { fetchImpl } = fetcher({});
  const source = createSource(PRIMARY, { fetchImpl, mirrors: [MIRROR, 'https://third.example/r'] });

  await assert.rejects(
    () => source.fetchIndex(),
    (error) => {
      assert.equal(error.code, 'E-NETWORK');
      // A user with three broken mirrors should not be told about one.
      assert.match(error.message, /primary\.example/);
      assert.match(error.message, /mirror\.example/);
      assert.match(error.message, /third\.example/);
      return true;
    },
  );
});

test('mirrors of a local directory are refused rather than silently ignored', async () => {
  // A directory is already reachable and exact; accepting a mirror here would imply the tool
  // might substitute a remote for a path the caller chose deliberately.
  assert.throws(
    () => createSource('./some/registry', { mirrors: [MIRROR] }),
    (error) => error.code === 'E-MIRROR-LOCAL',
  );
});

test('a local directory with no mirrors is unaffected', () => {
  const source = createSource('./some/registry', {});
  assert.equal(source.kind, 'local');
});

test('no mirrors means no wrapper, so nothing changes for the common case', () => {
  const source = createSource(PRIMARY, { fetchImpl: async () => {} });
  assert.ok(!(source instanceof MirroredRegistrySource));
  assert.equal(source.kind, 'http');
});

test('the mirror list is reported in preference order', () => {
  const source = createSource(PRIMARY, {
    fetchImpl: async () => {},
    mirrors: [MIRROR, 'https://third.example/r'],
  });
  assert.deepEqual(source.mirrors, [PRIMARY, MIRROR, 'https://third.example/r']);
});
