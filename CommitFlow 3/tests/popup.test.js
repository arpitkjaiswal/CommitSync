import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
test('popup loads, saves, reports failure and recovers through reset', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', dataset: {}, handlers: {}, disabled: false,
      addEventListener(event, fn) { this.handlers[event] = fn; }, setAttribute() {}
    });
    return elements.get(id);
  };
  let fail = false;
  let saved;
  const root = { dataset: {} };
  vm.runInNewContext(source, {
    document: { querySelector: element, documentElement: root },
    chrome: { runtime: { async sendMessage(message) {
      if (fail) throw new Error('Disconnected');
      if (message.type === 'CONFIG_SET') saved = message.config;
      return { ok: true, data: message.type === 'CONFIG_SET' ? message.config : { displayName: '', theme: 'system' } };
    } } }
  });
  await tick();
  assert.equal(element('#fields').disabled, false);
  element('#display-name').value = 'Arpit';
  element('#theme').value = 'dark';
  element('#settings').handlers.submit({ preventDefault() {} });
  assert.equal(element('#fields').disabled, true);
  await tick();
  assert.equal(saved.displayName, 'Arpit');
  assert.equal(root.dataset.theme, 'dark');
  assert.match(element('#status').textContent, /saved/);
  fail = true;
  element('#settings').handlers.submit({ preventDefault() {} });
  await tick();
  assert.equal(element('#status').dataset.error, 'true');
  assert.equal(element('#fields').disabled, false);
  fail = false;
  element('#reset').handlers.click();
  await tick();
  assert.equal(root.dataset.theme, 'system');
  assert.equal(element('#display-name').value, '');
});
