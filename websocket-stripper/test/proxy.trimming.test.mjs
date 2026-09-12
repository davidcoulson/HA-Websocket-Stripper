// Registry and Lovelace-resource trimming, plus the websocket-compression negotiation.
//
// None of this depends on HOW a connection is scoped: each trims to whatever allowlist the
// connection ended up with. With no per-connection scoping the allowlist is the union of the
// configured dashboards, which is what these tests exercise; once scoping lands the same code
// narrows to one dashboard's set with no change here.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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
  const onData = (b) => {
    out += b.toString();
    for (let i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i].re.test(out)) { listeners[i].resolve(out); listeners.splice(i, 1); }
    }
  };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
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


// Home Assistant's own websocket negotiates permessage-deflate. The `ws` library does not
// enable it server-side by default, so putting this proxy in front of HA dropped compression
// from the browser leg. These pin the negotiation in both directions.
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
    try {
      await px.waitForLog(/union allowlist for/);
      assert.doesNotMatch(await negotiated(`ws://127.0.0.1:${p2}/api/websocket`), /permessage-deflate/);
    } finally { px.kill(); }
  });
});

// Resources are instance-wide in HA, so every kiosk parses every custom card in the install —
// the largest remaining cost once states and registries are trimmed.
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

  const resourcesFor = async (p) => {
    const c = haClient(`ws://127.0.0.1:${p}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: 'lovelace/resources' })).result;
    c.close();
    return rows.map((r) => r.url);
  };

  it('keeps the resource providing a card a dashboard uses, drops the rest', async () => {
    const urls = await resourcesFor(port);
    assert.ok(urls.includes('/res/my-fancy-card.js'), 'the card this dashboard renders must survive');
    assert.ok(!urls.includes('/res/unrelated-widget.js'), 'a card no view references must be dropped');
  });

  // Regression: a loose icon-prefix pattern turns `16:9` and `06:00` into the keys "16" and
  // "06", and a 2-char string appears in every minified bundle — so everything matches and
  // nothing is dropped. That silently disabled the whole feature (39/45 kept, 97KB saved).
  it('is not fooled by aspect ratios and times into keeping everything', async () => {
    const cfg = { views: [{ cards: [
      { type: 'custom:my-fancy-card', entity: 'light.living_room', aspect_ratio: '16:9', schedule: '06:00' },
    ] }] };
    const m2 = await startMockHa({ configs: { 'ratio-dash': cfg } });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'ratio-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(/union allowlist for/);
      const urls = await resourcesFor(p2);
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
    try {
      await px.waitForLog(/union allowlist for/);
      const urls = await resourcesFor(p2);
      assert.ok(urls.includes('/res/global-patcher.js'), 'always_forward must win over the content match');
    } finally { px.kill(); }
  });

  it('serves the union across dashboards, since nothing says which one a socket shows', async () => {
    const m2 = await startMockHa({ configs: {
      'a-dash': { views: [{ cards: [{ type: 'custom:my-fancy-card', entity: 'light.living_room' }] }] },
      'b-dash': { views: [{ cards: [{ type: 'custom:unrelated-widget', entity: 'light.bedroom' }] }] },
    } });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'a-dash,b-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(/union allowlist for/);
      const urls = await resourcesFor(p2);
      assert.ok(urls.includes('/res/my-fancy-card.js') && urls.includes('/res/unrelated-widget.js'),
        'both dashboards\' cards must survive — serving less would break whichever one is open');
      assert.ok(!urls.includes('/res/global-patcher.js'), 'a resource no dashboard references is still dropped');
    } finally { px.kill(); await m2.close(); }
  });

  // The one failure the documented tuning loop ("load it and see what looks wrong") cannot
  // catch: a resource that registers no element and is named by no dashboard, but runs on
  // load and subscribes to state. Dropping it leaves the dashboard pixel-identical and only
  // stops the behaviour, so the log has to say which resources those could be.
  it('names the resources dropped by EVERY dashboard, since those fail silently', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(/drop\s+\d+KB \/res\/global-patcher\.js/);
      const out = px.out;
      assert.match(out, /dropped by ALL dashboards \(no dashboard references them\)/);
      assert.match(out, /INVISIBLE/, 'the warning must say the failure is invisible');
      assert.match(out, /resources_always_forward/, 'and name the option that fixes it');
      assert.match(out, /\/res\/global-patcher\.js/, 'and list the offending resource');
    } finally { px.kill(); }
  });

  it('trim_resources off (the default) leaves the list untouched', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2 });
    try {
      await px.waitForLog(/union allowlist for/);
      assert.equal((await resourcesFor(p2)).length, 3);
    } finally { px.kill(); }
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
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: 'config/entity_registry/list' })).result;
    c.close();
    assert.ok(Array.isArray(rows), 'registry came back as a list');
    const ids = new Set(rows.map((r) => r.entity_id));
    assert.ok(ids.has('light.living_room'), 'an entity this dashboard shows must survive');
    assert.ok(!ids.has('light.kitchen'), 'an entity no dashboard shows must not survive');
  });

  // The regression this pins: `list_for_display` answers with an OBJECT, so an
  // Array.isArray() guard on the result skipped it — and it is the single largest payload
  // the frontend fetches (1.44MB of a 2.46MB load on the instance this was built against).
  it('cuts list_for_display, which is an object and not a list', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const r = (await c.rpc({ type: 'config/entity_registry/list_for_display' })).result;
    c.close();
    assert.ok(r && !Array.isArray(r) && Array.isArray(r.entities), 'shape is {entity_categories, entities}');
    const ids = new Set(r.entities.map((e) => e.ei));      // rows key entity_id as `ei`
    assert.ok(ids.has('light.living_room'), 'an entity this dashboard shows must survive');
    assert.ok(!ids.has('light.kitchen'), 'an entity no dashboard shows must not survive');
    assert.deepEqual(r.entity_categories, { 0: 'config', 1: 'diagnostic' },
      'the category map is not per-entity and must be passed through intact');
  });

  it('trim_registries=0 leaves the registry untouched', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'test-dash', port: p2, extraEnv: { TRIM_REGISTRIES: '0' } });
    try {
      await px.waitForLog(/union allowlist for/);
      const c = haClient(`ws://127.0.0.1:${p2}/api/websocket`);
      await c.authed;
      const rows = (await c.rpc({ type: 'config/entity_registry/list' })).result;
      c.close();
      assert.ok(rows.some((r) => r.entity_id === 'light.kitchen'),
        'with trimming off, entities no dashboard shows must still pass through');
    } finally { px.kill(); }
  });
});
