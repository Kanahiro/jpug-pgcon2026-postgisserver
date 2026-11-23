import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidTile, parseRoute, props } from '../src/app.ts';

test('parseRoute', () => {
  assert.deepEqual(parseRoute('/roads.wkt'), { kind: 'wkt', table: 'roads' });
  assert.deepEqual(parseRoute('/roads.geojson'), { kind: 'geojson', table: 'roads' });
  assert.deepEqual(parseRoute('/roads/14/14552/6451.mvt'), { kind: 'mvt', table: 'roads', z: 14, x: 14552, y: 6451 });
  for (const p of ['/', '/roads', '/roads.json', '/a;b.wkt', '/a-b.geojson', '/roads/1/2.mvt', '/roads/1/-1/0.mvt']) {
    assert.equal(parseRoute(p), undefined, p);
  }
});

test('isValidTile', () => {
  assert.ok(isValidTile(0, 0, 0));
  assert.ok(isValidTile(1, 1, 1));
  assert.ok(!isValidTile(1, 2, 0));
  assert.ok(!isValidTile(1, 0, 2));
  assert.ok(!isValidTile(31, 0, 0));
});

test('props', () => {
  assert.equal(props([], 't'), '');
  assert.equal(props(['id', 'Name'], 't'), 't."id", t."Name", ');
  assert.equal(props(['a"b'], 't'), 't."a""b", ');
});
