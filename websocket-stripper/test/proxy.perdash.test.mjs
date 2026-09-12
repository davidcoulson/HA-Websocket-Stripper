// Per-dashboard allowlists + registry trimming.
//
// The union is what every connection used to get. These tests pin the two properties that
// make per-dashboard trimming safe to leave on by default:
//   1. a client that asked for dashboard A gets A's entities — NOT the union;
//   2. a client we can't attribute still gets the union, so nothing renders worse than before.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

function spawnProxy({ mock, dashPaths, port, extraEnv = {} }) {
  const proc = spawn(process.execPath, [PROXY], {
    cwd: path.join(DIR, '..'),
    env: {
      ...process.env,
      HA_BASE: mock.base,
      HA_TOKEN: 'test-token',
      DASH_PATHS: dashPaths,
      PORT: String(port),
      STRIP_ENTITIES: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const listeners = [];
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  function onData(b) {
    out += b.toString();
    for (let i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i].re.test(out)) { listeners[i].resolve(out); listeners.splice(i, 1); }
    }
  }
  const waitForLog = (re, ms = 8000) => new Promise((resolve, reject) => {
    if (re.test(out)) return resolve(out);
    const l = { re, resolve: (v) => { clearTimeout(t); resolve(v); } };
    listeners.push(l);
    const t = setTimeout(() => {
      const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1);
      reject(new Error(`timeout waiting for ${re}\n--- proxy output ---\n${out}`));
    }, ms);
  });
  return { proc, get out() { return out; }, waitForLog, kill: () => proc.kill() };
}

const httpGet = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    let body = ''; res.on('data', (c) => body += c);
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
});

// Ask for entity_ids the proxy injected for a connection opened after `pageUrl` was fetched
// (or with no page fetch at all, when pageUrl is null).
async function injectedFor(port, mock, pageUrl) {
  if (pageUrl) await httpGet(`http://127.0.0.1:${port}${pageUrl}`);
  const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
  await c.authed;
  c.send({ type: 'subscribe_entities' });
  await new Promise((r) => setTimeout(r, 300));
  const got = mock.lastSubscribeEntities();
  c.close();
  return new Set(got ?? []);
}

describe('per-dashboard allowlists', () => {
  let mock, proxy, port;
  // test-dash names 6 ids; auto-dash resolves a label filter to living_room + bedroom.
  const TEST_DASH = ['light.living_room', 'sensor.temperature', 'camera.front', 'binary_sensor.front_door', 'sensor.humidity', 'switch.fan'];

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash,auto-dash', port });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('serves one dashboard its OWN entities, not the union', async () => {
    const got = await injectedFor(port, mock, '/test-dash');
    assert.deepEqual(got, new Set(TEST_DASH));
    // light.bedroom belongs only to auto-dash — the whole point is that it is NOT sent here.
    assert.ok(!got.has('light.bedroom'), 'union-only entity must not leak into a single dashboard');
  });

  it('serves a different dashboard a different set from the same proxy', async () => {
    const got = await injectedFor(port, mock, '/auto-dash');
    assert.ok(got.has('light.bedroom'), 'auto-dash resolves its own label filter');
    assert.ok(!got.has('camera.front'), 'test-dash-only entity must not leak into auto-dash');
  });

  it('a view path under the dashboard still attributes to that dashboard', async () => {
    const got = await injectedFor(port, mock, '/test-dash/some-view');
    assert.deepEqual(got, new Set(TEST_DASH));
  });

  it('never injects an empty entity_ids (which HA reads as "no filter")', async () => {
    // An unknown path leaves the previous hint in place, which is deliberate — the point
    // here is only that we never end up injecting nothing.
    const got = await injectedFor(port, mock, '/not-a-dashboard');
    assert.ok(got.size > 0, 'an unknown path must never produce an empty entity_ids');
  });
});

// Deliberately its own proxy: the IP->dashboard hint is sticky by design, so a connection
// that has never fetched a dashboard page only exists on a freshly started proxy.
describe('an unattributed client still gets the union', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash,auto-dash', port });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('falls back to the union, never to a partial list', async () => {
    const got = await injectedFor(port, mock, null);
    assert.ok(got.has('light.bedroom') && got.has('camera.front'),
      'an unattributed connection must get the full union — the pre-feature behaviour');
  });
});

describe('per_dashboard=0 restores the union for every connection', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash,auto-dash', port, extraEnv: { PER_DASHBOARD: '0' } });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('ignores the page hint and serves the union', async () => {
    const got = await injectedFor(port, mock, '/test-dash');
    assert.ok(got.has('light.bedroom'), 'with the feature off, test-dash still gets the union');
  });
});

describe('registry trimming', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('cuts the entity registry to entities the connection can see', async () => {
    await httpGet(`http://127.0.0.1:${port}/test-dash`);
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: "config/entity_registry/list" })).result;
    c.close();
    assert.ok(Array.isArray(rows), 'registry came back as a list');
    const ids = new Set(rows.map((r) => r.entity_id));
    // test-dash uses living_room / temperature / fan; bedroom and kitchen belong to other
    // dashboards and must not survive.
    assert.ok(ids.has('light.living_room'), 'an entity this dashboard shows must survive');
    assert.ok(!ids.has('light.bedroom'), 'an entity from another dashboard must not survive');
    assert.ok(!ids.has('light.kitchen'), 'an entity no dashboard shows must not survive');
  });

  it('trim_registries=0 leaves the registry untouched', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'test-dash', port: p2, extraEnv: { TRIM_REGISTRIES: '0' } });
    await px.waitForLog(/union allowlist for/);
    await httpGet(`http://127.0.0.1:${p2}/test-dash`);
    const c = haClient(`ws://127.0.0.1:${p2}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: "config/entity_registry/list" })).result;
    c.close(); px.kill();
    assert.ok(rows.some((r) => r.entity_id === 'light.bedroom'),
      'with trimming off, entities from other dashboards must still pass through');
  });
});
