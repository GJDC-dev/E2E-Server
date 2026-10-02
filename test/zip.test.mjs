import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { crc32, detectRoot, isJunk, safePath, ZipError, ZipReader, ZipWriter, zipDirectory } from '../src/zip.mjs';
import { sha256File } from '../src/http.mjs';
import { tmp } from './helpers.mjs';

test('crc32 zoals in de ZIP-standaard', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('veilige paden', () => {
  assert.equal(safePath('tests/a.spec.ts'), 'tests/a.spec.ts');
  assert.equal(safePath('./tests//a.spec.ts'), 'tests/a.spec.ts');
  assert.equal(safePath('tests\\a.spec.ts'), 'tests/a.spec.ts');
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\u0000b', '']) {
    assert.equal(safePath(bad), null, bad);
  }
  assert.ok(isJunk('__MACOSX/x'));
  assert.ok(isJunk('a/.DS_Store'));
  assert.ok(!isJunk('a/b.ts'));
});

test('wortel herkennen', () => {
  assert.equal(detectRoot(['package.json', 'tests/a.ts']), '');
  assert.equal(detectRoot(['map/package.json', 'map/tests/a.ts']), 'map');
  assert.equal(detectRoot(['a/package.json', 'b/x']), '');
});

test('schrijven en lezen, reproduceerbaar', async () => {
  const dir = tmp();
  const src = path.join(dir, 'src');
  mkdirSync(path.join(src, 'tests'), { recursive: true });
  writeFileSync(path.join(src, 'package.json'), '{"name":"x"}');
  writeFileSync(path.join(src, 'tests', 'a.spec.ts'), 'x'.repeat(100000));
  writeFileSync(path.join(src, 'leeg.txt'), '');
  writeFileSync(path.join(src, 'plaatje.png'), Buffer.from([1, 2, 3, 4]));

  const fixed = new Date(2020, 0, 1);
  const a = path.join(dir, 'a.zip');
  const b = path.join(dir, 'b.zip');
  assert.equal(await zipDirectory(src, a, { fixedTime: fixed }), 4);
  await zipDirectory(src, b, { fixedTime: fixed });
  assert.equal(await sha256File(a), await sha256File(b), 'zelfde inhoud, zelfde sha256');

  const zip = await ZipReader.open(a);
  try {
    assert.deepEqual(zip.entries.map((e) => e.name).sort(), ['leeg.txt', 'package.json', 'plaatje.png', 'tests/a.spec.ts']);
    const out = path.join(dir, 'uit');
    const result = await zip.extractTo(out);
    assert.equal(result.files, 4);
    assert.equal(readFileSync(path.join(out, 'tests', 'a.spec.ts'), 'utf8').length, 100000);
    assert.equal(readFileSync(path.join(out, 'leeg.txt'), 'utf8'), '');
  } finally {
    await zip.close();
  }
});

test('uitpakken weigert paden buiten de doelmap', async () => {
  const dir = tmp();
  const file = path.join(dir, 'x.txt');
  writeFileSync(file, 'boos');
  const bad = path.join(dir, 'bad.zip');
  const writer = await ZipWriter.create(bad);
  await writer.addFile('ok.txt', file);
  await writer.addFile('../ontsnapt.txt', file);
  await writer.finish();

  const zip = await ZipReader.open(bad);
  try {
    await assert.rejects(zip.extractTo(path.join(dir, 'uit')), ZipError);
    assert.ok(!existsSync(path.join(dir, 'ontsnapt.txt')));
  } finally {
    await zip.close();
  }
});

test('geen ZIP of afgekapt', async () => {
  const dir = tmp();
  const fake = path.join(dir, 'nep.zip');
  writeFileSync(fake, 'dit is geen zip '.repeat(50));
  await assert.rejects(ZipReader.open(fake), ZipError);
});
