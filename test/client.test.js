'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { HeatzyClient, HeatzyError } = require('../lib/client');

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

function makeClient(handler) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return handler(requests.at(-1), requests.length);
  };
  const client = new HeatzyClient({ username: 'a@b.fr', password: 'secret', log: console, fetchImpl });
  return { client, requests };
}

test('login then authenticated request with the Gizwits headers', async () => {
  const { client, requests } = makeClient((req) =>
    req.url.endsWith('/login') ? reply(200, { token: 'tok1', expire_at: Math.floor(Date.now() / 1000) + 3600 }) : reply(200, { attr: { mode: 'cft' } }),
  );
  assert.deepEqual(await client.getLatest('did1'), { mode: 'cft' });
  assert.equal(requests[0].url, 'https://euapi.gizwits.com/app/login');
  assert.deepEqual(requests[0].body, { username: 'a@b.fr', password: 'secret' });
  assert.equal(requests[1].url, 'https://euapi.gizwits.com/app/devdata/did1/latest');
  assert.equal(requests[1].init.headers['X-Gizwits-User-token'], 'tok1');
  assert.equal(requests[1].init.headers['X-Gizwits-Application-Id'], 'c70a66ff039d41b4a220e198b0fcc8b3');
});

test('token rejected (400/9004): automatic re-login then retry', async () => {
  let logins = 0;
  const { client } = makeClient((req) => {
    if (req.url.endsWith('/login')) {
      logins += 1;
      return reply(200, { token: `tok${logins}`, expire_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    return req.init.headers['X-Gizwits-User-token'] === 'tok1' ? reply(400, { error_code: 9004, detail_message: 'token invalid' }) : reply(200, { attr: { mode: 'eco' } });
  });
  assert.deepEqual(await client.getLatest('did1'), { mode: 'eco' });
  assert.equal(logins, 2);
});

test('credentials rejected: explicit error, no loop', async () => {
  const { client, requests } = makeClient(() => reply(400, { error_code: 9020, detail_message: 'bad credentials' }));
  await assert.rejects(client.getLatest('did1'), (error) => error instanceof HeatzyError && /bad credentials/.test(error.message));
  assert.equal(requests.length, 1);
});

test('token expired locally: re-login before the request', async () => {
  let logins = 0;
  const { client } = makeClient((req) => {
    if (req.url.endsWith('/login')) {
      logins += 1;
      return reply(200, { token: `tok${logins}`, expire_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    return reply(200, { attr: {} });
  });
  await client.getLatest('a');
  client.expiresAt = Date.now() - 1;
  await client.getLatest('b');
  assert.equal(logins, 2);
});

test('module list and empty /control response', async () => {
  const { client, requests } = makeClient((req) => {
    if (req.url.endsWith('/login')) return reply(200, { token: 't', expire_at: Math.floor(Date.now() / 1000) + 3600 });
    if (req.url.includes('/bindings')) return reply(200, { devices: [{ did: 'x' }] });
    return reply(200, undefined);
  });
  assert.deepEqual(await client.listBindings(), [{ did: 'x' }]);
  await client.control('x', { attrs: { mode: 1 } });
  assert.equal(requests.at(-1).init.method, 'POST');
  assert.deepEqual(requests.at(-1).body, { attrs: { mode: 1 } });
});
