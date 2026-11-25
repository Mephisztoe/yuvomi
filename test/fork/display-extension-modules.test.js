/**
 * Fork: Erweiterungsmodule auf einem gekoppelten Wandtablett
 * (DISPLAY_EXTENSION_MODULES, server/display-scopes.js).
 *
 * Geprueft wird am laufenden Server, mit zwei Modulen im Modulordner:
 *   - `buecherei` steht in DISPLAY_EXTENSION_MODULES
 *   - `geheim` steht nicht darin
 * Das Display bekommt fuer `buecherei` genau `read` und darf dessen Dateien
 * laden; `geheim` bleibt `none` und gesperrt; an der festen Liste der
 * Kernmodule aendert sich nichts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startTestServer, cookieHeader } from '../server-ready.js';

const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuvomi-display-ext-'));
for (const id of ['buecherei', 'geheim']) {
  const dir = path.join(modulesDir, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify({
    manifestVersion: 1,
    id,
    name: id,
    version: '0.1.0',
    entry: 'index.js',
    menu: { show: true, label: id, icon: 'library' },
    capabilities: { permissions: { module: { label: id, icon: 'library' } } },
  }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function render() {}\n');
}

const { baseUrl: BASE } = await startTestServer({
  name: 'display-extension-modules',
  env: {
    SESSION_SECRET: 'test-display-extension-modules-secret-32',
    MODULES_DIR: modulesDir,
    DISPLAY_EXTENSION_MODULES: ' buecherei , Unsinn!, buecherei ',
  },
});
const { DISPLAY_COOKIE } = await import('../../server/services/display-accounts.js');
const {
  parseDisplayExtensionModules, displayMayReadExtensionAsset, DISPLAY_EXTENSION_MODULES,
} = await import('../../server/display-scopes.js');

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});

async function adminSession() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'adminpass123' }),
  });
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return async (method, p, body) => {
    const r = await fetch(`${BASE}/api/v1${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': me.csrfToken },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

const admin = await adminSession();
const created = await admin('POST', '/displays', { display_name: 'Kueche' });
const issued = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});
const pairRes = await fetch(`${BASE}/api/v1/displays/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: issued.body.data.code }),
});
const token = decodeURIComponent(
  String(pairRes.headers.get('set-cookie')).match(new RegExp(`${DISPLAY_COOKIE}=([^;]+)`))[1],
);

function asDisplay(method, p) {
  return fetch(`${BASE}/api/v1${p}`, { method, headers: { Cookie: `${DISPLAY_COOKIE}=${token}` } });
}

test('die Variable wird streng gelesen: Ids nach Modulregel, ohne Dubletten', () => {
  assert.deepEqual([...DISPLAY_EXTENSION_MODULES], ['buecherei']);
  assert.deepEqual([...parseDisplayExtensionModules('')], [], 'ohne Variable bleibt alles wie im Original');
  assert.deepEqual([...parseDisplayExtensionModules('a-b,../x,C')], ['a-b', 'c']);
});

test('nur GET auf Dateien freigegebener Module', () => {
  assert.equal(displayMayReadExtensionAsset('GET', '/modules/assets/buecherei/index.js'), true);
  assert.equal(displayMayReadExtensionAsset('POST', '/modules/assets/buecherei/index.js'), false);
  assert.equal(displayMayReadExtensionAsset('GET', '/modules/assets/geheim/index.js'), false);
  assert.equal(displayMayReadExtensionAsset('GET', '/modules/assets/buecherei/'), false);
  assert.equal(displayMayReadExtensionAsset('GET', '/modules/assets/buecherei-x/index.js'), false);
});

test('das Display bekommt fuer das freigegebene Modul read, fuer alle anderen none', async () => {
  const res = await asDisplay('GET', '/auth/me');
  assert.equal(res.status, 200);
  const me = await res.json();
  assert.equal(me.user.access_scope, 'display');
  assert.equal(me.permissions.modules['ext:buecherei'], 'read');
  assert.equal(me.permissions.modules['ext:geheim'], 'none');
  // Die feste Liste des Originals bleibt, wie sie ist.
  assert.equal(me.permissions.modules.calendar, 'read');
  assert.equal(me.permissions.modules.budget, 'none');
});

test('die Moduldateien des freigegebenen Moduls laden, die anderen nicht', async () => {
  const ok = await asDisplay('GET', '/modules/assets/buecherei/index.js');
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /export function render/);
  assert.equal((await asDisplay('GET', '/modules/assets/geheim/index.js')).status, 403);
  assert.equal((await asDisplay('GET', '/modules/assets/buecherei/module.json')).status === 403, false,
    'die Route selbst entscheidet ueber einzelne Dateien, das Gate nur ueber das Modul');
});

test('das Display kann ueber die Freigabe nichts schreiben', async () => {
  const res = await fetch(`${BASE}/api/v1/modules/buecherei`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: `${DISPLAY_COOKIE}=${token}` },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(res.status, 403);
});

test('ein normales Mitglied wird von der Variable nicht beruehrt', async () => {
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, {
    headers: { Cookie: cookieHeader((await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminpass123' }),
    })).headers.get('set-cookie')) },
  })).json();
  assert.equal(me.permissions.admin, true);
  assert.equal(me.permissions.modules['ext:geheim'], 'write');
});
