import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineSplitter, Redactor } from '../src/redact.mjs';

test('geheimen worden weggepoetst, ook gecodeerd', () => {
  const secret = 'Wacht w00rd&!';
  const r = new Redactor([secret, 'abc', '']);
  const text = [
    `wachtwoord=${secret}`,
    `url: https://x/?p=${encodeURIComponent(secret)}`,
    `basic ${Buffer.from(secret).toString('base64')}`,
    `json ${JSON.stringify({ p: secret })}`,
    'abc blijft staan (te kort om veilig te vervangen)',
  ].join('\n');
  const out = r.redact(text);
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes(encodeURIComponent(secret)));
  assert.ok(!out.includes(Buffer.from(secret).toString('base64').replace(/=+$/, '')));
  assert.equal(out.split('••••••').length - 1, 4);
  assert.ok(out.includes('abc blijft staan'));
});

test('zonder geheimen verandert er niets', () => {
  assert.equal(new Redactor([]).redact('hallo'), 'hallo');
});

test('regels: een geheim over twee stukken wordt toch herkend', () => {
  const r = new Redactor(['supergeheim']);
  const out = [];
  const splitter = new LineSplitter((t) => out.push(r.redact(t)));
  splitter.push('begin super');
  splitter.push('geheim einde\nvolgende');
  splitter.push(' regel\r');
  splitter.end();
  const all = out.join('');
  assert.equal(all, 'begin •••••• einde\nvolgende regel\r');
  assert.ok(!all.includes('supergeheim'));
});
