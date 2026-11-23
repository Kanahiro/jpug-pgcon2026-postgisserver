// 結合テスト: PostGIS が必要。DATABASE_URL 未設定ならスキップ
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { createServer } from '../src/app.ts';

const DATABASE_URL = process.env.DATABASE_URL;

describe('server', { skip: !DATABASE_URL && 'DATABASE_URL が未設定' }, () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const server = createServer(pool);
  let base = '';
  const get = (path: string) => fetch(base + path);

  before(async () => {
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS postgis;
      DROP TABLE IF EXISTS test_points, test_polys, test_empty;
      CREATE TABLE test_points (id int, name text, geom geometry(Point, 4326));
      INSERT INTO test_points VALUES (1, '東京', 'SRID=4326;POINT(139.7671 35.6812)'), (2, '新宿', 'SRID=4326;POINT(139.7005 35.6896)');
      CREATE TABLE test_polys (code text, geom geometry(Polygon, 6677));
      INSERT INTO test_polys VALUES ('A', ST_Buffer(ST_Transform('SRID=4326;POINT(139.7671 35.6812)'::geometry, 6677), 100));
      CREATE TABLE test_empty (id int, geom geometry(Point, 4326));
    `);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    await pool.query('DROP TABLE IF EXISTS test_points, test_polys, test_empty');
    await pool.end();
  });

  test('GET / はビューアを返す', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /importmap/);
  });

  test('GET /viewer.js は型を剥がした JS を返す', async () => {
    const res = await get('/viewer.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
    const js = await res.text();
    assert.match(js, /from 'maplibre-gl'/);
    assert.doesNotMatch(js, /: HTMLElement|satisfies /);
  });

  test('GET /maplibre-gl/* は dist のファイルだけ返す', async () => {
    assert.equal((await get('/maplibre-gl/maplibre-gl.mjs')).status, 200);
    assert.equal((await get('/maplibre-gl/maplibre-gl.css')).headers.get('content-type'), 'text/css');
    assert.equal((await get('/maplibre-gl/maplibre-gl-nope.mjs')).status, 404);
    assert.equal((await get('/maplibre-gl/package.json')).status, 404);
    assert.equal((await get('/maplibre-gl/%2e%2e%2fpackage.json')).status, 404);
  });

  test('GET /tables.json', async () => {
    const tables: { name: string; srid: number; bbox: number[] | null; columns: string[] }[] = await (
      await get('/tables.json')
    ).json();
    const points = tables.find((t) => t.name === 'test_points');
    assert.deepEqual(points?.columns, ['id', 'name']);
    assert.deepEqual(points?.bbox, [139.7005, 35.6812, 139.7671, 35.6896]);
    assert.equal(tables.find((t) => t.name === 'test_polys')?.srid, 6677);
    assert.equal(tables.find((t) => t.name === 'test_empty')?.bbox, null);
  });

  test('GET /{table}.wkt は元の SRID のまま返す', async () => {
    const res = await get('/test_points.wkt');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(await res.text(), 'POINT(139.7671 35.6812)\nPOINT(139.7005 35.6896)');
    const poly = await (await get('/test_polys.wkt')).text();
    assert.match(poly, /^POLYGON\(\(-\d+/); // 平面直角座標（m）
    assert.equal(await (await get('/test_empty.wkt')).text(), '');
  });

  test('GET /{table}.geojson は EPSG:4326 の FeatureCollection を返す', async () => {
    const res = await get('/test_polys.geojson');
    assert.equal(res.headers.get('content-type'), 'application/geo+json');
    const fc = await res.json();
    assert.equal(fc.type, 'FeatureCollection');
    assert.deepEqual(fc.features[0].properties, { code: 'A' });
    const [lng, lat] = fc.features[0].geometry.coordinates[0][0];
    assert.ok(Math.abs(lng - 139.7671) < 0.01 && Math.abs(lat - 35.6812) < 0.01);
    assert.deepEqual(await (await get('/test_empty.geojson')).json(), { type: 'FeatureCollection', features: [] });
  });

  test('GET /{table}/{z}/{x}/{y}.mvt', async () => {
    const res = await get('/test_polys/14/14552/6451.mvt'); // 東京駅を含むタイル
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.mapbox-vector-tile');
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.includes('test_polys') && body.includes('code'));
    // 西半球側のタイルは空
    assert.equal((await (await get('/test_polys/1/0/1.mvt')).arrayBuffer()).byteLength, 0);
  });

  test('異常系', async () => {
    assert.equal((await get('/nope.geojson')).status, 404);
    assert.equal((await get('/nope/0/0/0.mvt')).status, 404);
    assert.equal((await get('/test_points;DROP.geojson')).status, 404);
    assert.equal((await get('/test_points.json')).status, 404);
    assert.equal((await get('/test_points/1/2/0.mvt')).status, 400);
    assert.equal((await get('/test_points/31/0/0.mvt')).status, 400);
  });
});
