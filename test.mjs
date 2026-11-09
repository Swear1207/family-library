import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLibraryServer } from './server.mjs';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoot = path.join(projectDir, '.test-data');
const trustedOrigin = 'http://nas.test';
const username = 'test_family';
const initialPassword = 'Temporary-library-test-482!';
const changedPassword = 'Updated-library-test-593!';

test('standalone NAS library: authentication, sharing, persistence and isolation', async t => {
  await mkdir(temporaryRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(temporaryRoot, 'integration-'));
  let instance;
  let baseUrl;
  let creatorCookie;
  let familyCookie;
  let changedCookie;
  let setupToken;
  let savedVersion;
  const book = {
    id: 'test-book-1',
    title: '家庭书架测试',
    author: '测试作者',
    category: '文学小说',
    status: '未读',
    location: '客厅 · 第一层',
    borrower: '',
    notes: '重启后也应保存。',
    color: '#456258',
    demo: false,
    created: 1700000000000,
  };

  async function start() {
    instance = await createLibraryServer({ dataDir, origin: trustedOrigin, host: '127.0.0.1', port: 0 });
    await new Promise((resolve, reject) => {
      instance.server.once('error', reject);
      instance.server.listen(0, '127.0.0.1', () => {
        instance.server.off('error', reject);
        resolve();
      });
    });
    baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
  }

  async function stop() {
    if (instance) {
      const current = instance;
      instance = undefined;
      await current.close();
    }
  }

  async function request(route, options = {}) {
    const { method = 'GET', data, rawBody, cookie, origin = trustedOrigin, contentType } = options;
    const headers = {};
    if (origin !== null) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    if (data !== undefined || rawBody !== undefined) headers['Content-Type'] = contentType || 'application/json';
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: rawBody !== undefined ? rawBody : data !== undefined ? JSON.stringify(data) : undefined,
      redirect: 'manual',
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { /* Static assets are not JSON. */ }
    return { status: response.status, headers: response.headers, text, json };
  }

  function getCookie(response) {
    const header = response.headers.get('set-cookie');
    assert.ok(header, 'successful authentication sets a session cookie');
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=Strict/i);
    assert.doesNotMatch(header, /(?:^|;)\s*Secure(?:;|$)/i, 'HTTP LAN must not set Secure cookies');
    return header.split(';')[0];
  }

  async function expectStatus(route, options, expected) {
    const result = await request(route, options);
    assert.equal(result.status, expected, `${options?.method || 'GET'} ${route} status`);
    return result;
  }

  t.after(async () => {
    await stop();
    // Delete only this test's freshly-created child directory.
    const resolvedRoot = path.resolve(temporaryRoot);
    const resolvedTarget = path.resolve(dataDir);
    assert.equal(path.dirname(resolvedTarget), resolvedRoot, 'cleanup stays inside .test-data');
    assert.ok(path.basename(resolvedTarget).startsWith('integration-'), 'cleanup targets this test run');
    await rm(resolvedTarget, { recursive: true, force: true });
  });

  await start();
  setupToken = (await readFile(path.join(dataDir, 'setup-token.txt'), 'utf8')).trim();
  assert.ok(setupToken.length >= 24, 'bootstrap secret has sufficient length');

  await t.test('serves the interface but protects book data and server files', async () => {
    const home = await expectStatus('/', {}, 200);
    assert.match(home.text, /一屋书/);
    const state = await expectStatus('/api/family/session', {}, 200);
    assert.equal(state.json.configured, false);
    assert.equal(state.json.authenticated, false);
    assert.equal(state.json.canSetup, true);
    await expectStatus('/api/family/books', {}, 401);
    for (const route of ['/setup-token.txt', '/data/setup-token.txt', '/data/library.sqlite', '/server.mjs', '/.env', '/%2e%2e%2fsetup-token.txt']) {
      const result = await request(route);
      assert.ok([400, 403, 404].includes(result.status), `${route} is not served`);
      assert.ok(!result.text.includes(setupToken), 'bootstrap token is never exposed by HTTP');
    }
  });

  await t.test('rejects foreign and missing origins and incorrect bootstrap tokens', async () => {
    const data = { username, password: initialPassword, setupToken };
    await expectStatus('/api/family/setup', { method: 'POST', data, origin: 'http://untrusted.example' }, 403);
    await expectStatus('/api/family/setup', { method: 'POST', data, origin: null }, 403);
    const invalid = await request('/api/family/setup', { method: 'POST', data: { ...data, setupToken: 'incorrect-bootstrap-token' } });
    assert.ok([401, 403].includes(invalid.status), 'incorrect bootstrap token is rejected');
    const state = await expectStatus('/api/family/session', {}, 200);
    assert.equal(state.json.configured, false);
  });

  await t.test('initializes one shared account and refuses repeat setup', async () => {
    const setup = await expectStatus('/api/family/setup', {
      method: 'POST', data: { username, password: initialPassword, setupToken },
    }, 200);
    creatorCookie = getCookie(setup);
    const state = await expectStatus('/api/family/session', { cookie: creatorCookie }, 200);
    assert.equal(state.json.configured, true);
    assert.equal(state.json.authenticated, true);
    await expectStatus('/api/family/setup', {
      method: 'POST', data: { username: 'another_family', password: initialPassword, setupToken },
    }, 409);
  });

  await t.test('authenticates another family device without exposing credentials', async () => {
    await expectStatus('/api/family/login', {
      method: 'POST', data: { username, password: 'wrong-password' },
    }, 401);
    const login = await expectStatus('/api/family/login', {
      method: 'POST', data: { username, password: initialPassword },
    }, 200);
    familyCookie = getCookie(login);
    assert.ok(creatorCookie !== familyCookie, 'devices receive distinct session tokens');
    assert.ok(!login.text.includes(initialPassword), 'password is not returned');
    assert.ok(!login.text.includes(setupToken), 'bootstrap secret is not returned');
  });

  await t.test('shares books and prevents stale writes from another device', async () => {
    const initial = await expectStatus('/api/family/books', { cookie: creatorCookie }, 200);
    assert.deepEqual(initial.json.books, []);
    assert.equal(initial.json.version, 0);
    const saved = await expectStatus('/api/family/books', {
      method: 'PUT', cookie: creatorCookie, data: { version: initial.json.version, books: [book] },
    }, 200);
    savedVersion = saved.json.version;
    assert.equal(savedVersion, 1);
    const shared = await expectStatus('/api/family/books', { cookie: familyCookie }, 200);
    assert.deepEqual(shared.json.books, [book]);
    assert.equal(shared.json.version, savedVersion);
    await expectStatus('/api/family/books', {
      method: 'PUT', cookie: familyCookie, data: { version: 0, books: [] },
    }, 409);
    const unchanged = await expectStatus('/api/family/books', { cookie: creatorCookie }, 200);
    assert.deepEqual(unchanged.json.books, [book]);
    assert.equal(unchanged.json.version, savedVersion);
  });

  await t.test('validates input, rejects malformed JSON and protects authenticated mutations', async () => {
    for (const data of [
      { version: savedVersion, books: [{ ...book, title: '' }] },
      { version: savedVersion, books: [{ ...book, id: 'x'.repeat(101) }] },
      { version: savedVersion, books: [book, book] },
      { version: savedVersion, books: [{ ...book, status: 'invalid' }] },
      { version: -1.5, books: [book] },
    ]) await expectStatus('/api/family/books', { method: 'PUT', cookie: creatorCookie, data }, 400);
    await expectStatus('/api/family/books', { method: 'PUT', cookie: creatorCookie, rawBody: '{broken' }, 400);
    const invalidType = await request('/api/family/books', {
      method: 'PUT', cookie: creatorCookie, rawBody: '{}', contentType: 'text/plain',
    });
    assert.ok([400, 415].includes(invalidType.status), 'non-JSON mutation body is rejected');
    await expectStatus('/api/family/books', { method: 'PUT', data: { version: savedVersion, books: [] } }, 401);
    await expectStatus('/api/family/books', {
      method: 'PUT', cookie: creatorCookie, origin: 'http://untrusted.example', data: { version: savedVersion, books: [] },
    }, 403);
    const tooLarge = await request('/api/family/books', {
      method: 'PUT', cookie: creatorCookie, rawBody: JSON.stringify({ oversized: 'x'.repeat(5 * 1024 * 1024) }),
    });
    assert.ok([400, 413].includes(tooLarge.status), 'request bodies over 5 MiB are rejected');
  });

  await t.test('retains account, sessions, books and version after server restart', async () => {
    await stop();
    await start();
    const state = await expectStatus('/api/family/session', { cookie: creatorCookie }, 200);
    assert.equal(state.json.configured, true);
    assert.equal(state.json.authenticated, true);
    const stored = await expectStatus('/api/family/books', { cookie: familyCookie }, 200);
    assert.deepEqual(stored.json.books, [book]);
    assert.equal(stored.json.version, savedVersion);
  });

  await t.test('password change revokes prior sessions and accepts only the new password', async () => {
    const changed = await expectStatus('/api/family/password', {
      method: 'POST', cookie: creatorCookie, data: { currentPassword: initialPassword, password: changedPassword },
    }, 200);
    changedCookie = getCookie(changed);
    await expectStatus('/api/family/books', { cookie: familyCookie }, 401);
    await expectStatus('/api/family/books', { cookie: creatorCookie }, 401);
    await expectStatus('/api/family/books', { cookie: changedCookie }, 200);
    await expectStatus('/api/family/login', {
      method: 'POST', data: { username, password: initialPassword },
    }, 401);
    const relogin = await expectStatus('/api/family/login', {
      method: 'POST', data: { username, password: changedPassword },
    }, 200);
    familyCookie = getCookie(relogin);
  });

  await t.test('logout revokes only the current device session', async () => {
    const logout = await expectStatus('/api/family/logout', { method: 'POST', cookie: familyCookie, data: {} }, 200);
    assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/i);
    await expectStatus('/api/family/books', { cookie: familyCookie }, 401);
    const state = await expectStatus('/api/family/session', { cookie: familyCookie }, 200);
    assert.equal(state.json.authenticated, false);
    await expectStatus('/api/family/books', { cookie: changedCookie }, 200);
  });
});
