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
import { WebSocket as WS } from 'ws';
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

// HA's own websocket negotiates permessage-deflate. `ws` does not enable it server-side by
// default, so inserting this proxy silently dropped compression from the browser leg.
describe('websocket compression', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  const negotiated = (url) => new Promise((resolve) => {
    const ws = new WS(url, { perMessageDeflate: true });
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
    ws.on('upgrade', (r) => finish(r.headers['sec-websocket-extensions'] || ''));
    ws.on('error', () => finish(''));
    setTimeout(() => finish(''), 5000);
  });

  it('offers permessage-deflate to the browser, as HA itself does', async () => {
    assert.match(await negotiated(`ws://127.0.0.1:${port}/api/websocket`), /permessage-deflate/);
  });

  it('compress_websocket=0 turns it off', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'test-dash', port: p2, extraEnv: { COMPRESS_WS: '0' } });
    await px.waitForLog(/union allowlist for/);
    const ext = await negotiated(`ws://127.0.0.1:${p2}/api/websocket`);
    px.kill();
    assert.doesNotMatch(ext, /permessage-deflate/);
  });
});

// Lovelace resources are instance-wide in HA, so every kiosk parses every custom card in the
// install — the largest remaining cost once states and registries are trimmed.
describe('resource trimming', () => {
  let mock, proxy, port;
  // A dashboard whose only custom card is `custom:my-fancy-card`.
  const CFG = { views: [{ cards: [{ type: 'custom:my-fancy-card', entity: 'light.living_room' }] }] };

  before(async () => {
    mock = await startMockHa({ configs: { 'res-dash': CFG } });
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'res-dash', port, extraEnv: { TRIM_RESOURCES: '1' } });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  const resourcesFor = async (p, pageUrl) => {
    if (pageUrl) await httpGet(`http://127.0.0.1:${p}${pageUrl}`);
    const c = haClient(`ws://127.0.0.1:${p}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: 'lovelace/resources' })).result;
    c.close();
    return rows.map((r) => r.url);
  };

  it('keeps the resource providing a card the dashboard uses, drops the rest', async () => {
    const urls = await resourcesFor(port, '/res-dash');
    assert.ok(urls.includes('/res/my-fancy-card.js'), 'the card this dashboard renders must survive');
    assert.ok(!urls.includes('/res/unrelated-widget.js'), 'a card no view references must be dropped');
  });

  // Regression: a loose icon-prefix pattern turns `16:9` and `06:00` into the keys "16" and
// "06", and a 2-char string appears in every minified bundle — so everything matches and
  // nothing is dropped. That silently disabled the whole feature (39/45 kept, 97KB saved).
  it('is not fooled by aspect ratios and times into keeping everything', async () => {
    // The entity matters: with none, the allowlist is empty and the proxy rightly refuses the
    // websocket with 503, which fails this test for an unrelated reason.
    const cfg = { views: [{ cards: [
      { type: 'custom:my-fancy-card', entity: 'light.living_room', aspect_ratio: '16:9', schedule: '06:00' },
    ] }] };
    const m2 = await startMockHa({ configs: { 'ratio-dash': cfg } });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'ratio-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(/union allowlist for/);
      const urls = await resourcesFor(p2, '/ratio-dash');
      assert.ok(!urls.includes('/res/unrelated-widget.js'),
        'an aspect_ratio must not become a match-everything key');
    } finally {
      // finally, not trailing statements: a throw above otherwise leaks the proxy and mock,
      // and the open handles hang the whole test FILE rather than failing one test.
      px.kill(); await m2.close();
    }
  });

  it('resources_always_forward rescues a global plugin that registers no card', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1', RESOURCES_ALWAYS_FORWARD: 'global-patcher' } });
    await px.waitForLog(/union allowlist for/);
    const urls = await resourcesFor(p2, '/res-dash');
    px.kill();
    assert.ok(urls.includes('/res/global-patcher.js'), 'always_forward must win over the content match');
  });

  it('an unattributed connection still gets every resource', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    await px.waitForLog(/union allowlist for/);
    const urls = await resourcesFor(p2, null);   // no page GET -> no dashboard attribution
    px.kill();
    assert.equal(urls.length, 3, 'a connection we cannot attribute must not have resources removed');
  });

  it('trim_resources off (the default) leaves the list untouched', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2 });
    await px.waitForLog(/union allowlist for/);
    const urls = await resourcesFor(p2, '/res-dash');
    px.kill();
    assert.equal(urls.length, 3);
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

  // The regression this pins: `list_for_display` answers with an OBJECT, so an
  // Array.isArray() guard on the result skipped it — and it is the single largest payload
  // the frontend fetches (1.44MB of a 2.46MB load on the instance this was built against).
  it('cuts list_for_display, which is an object and not a list', async () => {
    await httpGet(`http://127.0.0.1:${port}/test-dash`);
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const r = (await c.rpc({ type: 'config/entity_registry/list_for_display' })).result;
    c.close();
    assert.ok(r && !Array.isArray(r) && Array.isArray(r.entities), 'shape is {entity_categories, entities}');
    const ids = new Set(r.entities.map((e) => e.ei));      // rows key entity_id as `ei`
    assert.ok(ids.has('light.living_room'), 'an entity this dashboard shows must survive');
    assert.ok(!ids.has('light.bedroom'), 'an entity from another dashboard must not survive');
    assert.ok(!ids.has('light.kitchen'), 'an entity no dashboard shows must not survive');
    assert.deepEqual(r.entity_categories, { 0: 'config', 1: 'diagnostic' },
      'the category map is not per-entity and must be passed through intact');
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
