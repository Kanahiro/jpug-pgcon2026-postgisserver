// npm i && node server.mjs
//   GET /                            検証用ビューア（index.html）
//   GET /tables.json                 配信可能なテーブル一覧（bbox は EPSG:4326）
//   GET /{table}.wkt                 1行1ジオメトリのWKT（元のSRIDのまま）
//   GET /{table}.geojson             FeatureCollection（EPSG:4326）
//   GET /{table}/{z}/{x}/{y}.mvt     Mapbox Vector Tile（レイヤ名 = テーブル名）
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/gis',
});
const q = pg.escapeIdentifier;

// geometry_columns に載っているテーブルだけ受け付ける（SQLインジェクション対策を兼ねる）
// ponytail: 永久キャッシュ。カラム追加・テーブル再作成はサーバー再起動で反映
const metaCache = new Map();
async function getMeta(table) {
  if (metaCache.has(table)) return metaCache.get(table);
  const { rows } = await pool.query(
    `SELECT g.f_geometry_column AS geom, g.srid, g.type,
       coalesce((SELECT array_agg(c.column_name::text ORDER BY c.ordinal_position)
         FROM information_schema.columns c
         WHERE c.table_schema = g.f_table_schema AND c.table_name = g.f_table_name
           AND c.udt_name NOT IN ('geometry', 'geography')), '{}') AS cols
     FROM geometry_columns g
     WHERE g.f_table_schema = 'public' AND g.f_table_name = $1
     LIMIT 1`,
    [table],
  );
  if (rows[0]) metaCache.set(table, rows[0]);
  return rows[0];
}

const props = (cols, alias) => cols.map((c) => `${alias}.${q(c)}`).join(', ') + (cols.length ? ',' : '');

// ponytail: bbox は毎回 ST_Extent で全件走査。大きいテーブルなら ST_EstimatedExtent に
async function listTables() {
  const { rows } = await pool.query(
    `SELECT DISTINCT f_table_name::text AS name FROM geometry_columns WHERE f_table_schema = 'public' ORDER BY 1`,
  );
  return Promise.all(
    rows.filter((r) => /^\w+$/.test(r.name)).map(async ({ name }) => {
      const m = await getMeta(name);
      const { rows: [b] } = await pool.query(
        `SELECT ST_XMin(e) AS x1, ST_YMin(e) AS y1, ST_XMax(e) AS x2, ST_YMax(e) AS y2 FROM (
           SELECT ST_Transform(ST_SetSRID(ST_Extent(${q(m.geom)})::geometry, ${Number(m.srid)}), 4326) AS e FROM ${q(name)}
         ) s`,
      );
      return { name, srid: m.srid, type: m.type, columns: m.cols, bbox: b.x1 == null ? null : [b.x1, b.y1, b.x2, b.y2] };
    }),
  );
}

const handlers = {
  async wkt(m, t) {
    const { rows } = await pool.query(
      `SELECT coalesce(string_agg(ST_AsText(${q(m.geom)}), E'\\n'), '') AS body FROM ${q(t)}`,
    );
    return ['text/plain; charset=utf-8', rows[0].body];
  },

  async geojson(m, t) {
    const { rows } = await pool.query(
      `SELECT json_build_object('type', 'FeatureCollection', 'features',
         coalesce(json_agg(ST_AsGeoJSON(s.*, '__geom')::json), '[]'))::text AS body
       FROM (SELECT ${props(m.cols, 't')} ST_Transform(t.${q(m.geom)}, 4326) AS __geom FROM ${q(t)} t) s`,
    );
    return ['application/geo+json', rows[0].body];
  },

  async mvt(m, t, z, x, y) {
    const { rows } = await pool.query(
      `WITH b AS (SELECT ST_TileEnvelope($1, $2, $3) AS e)
       SELECT ST_AsMVT(s.*, $4::text, 4096, '__geom') AS body FROM (
         SELECT ${props(m.cols, 't')} ST_AsMVTGeom(ST_Transform(t.${q(m.geom)}, 3857), b.e) AS __geom
         FROM ${q(t)} t, b
         WHERE t.${q(m.geom)} && ST_Transform(b.e, ${Number(m.srid)})
       ) s`,
      [z, x, y, t],
    );
    return ['application/vnd.mapbox-vector-tile', rows[0].body ?? Buffer.alloc(0)];
  },
};

const routes = [
  [/^\/(\w+)\.wkt$/, 'wkt'],
  [/^\/(\w+)\.geojson$/, 'geojson'],
  [/^\/(\w+)\/(\d+)\/(\d+)\/(\d+)\.mvt$/, 'mvt'],
];

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const path = new URL(req.url, 'http://x').pathname;
  try {
    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./index.html', import.meta.url)));
    }
    if (path === '/tables.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(await listTables()));
    }
    for (const [re, name] of routes) {
      const match = path.match(re);
      if (!match) continue;
      const [, table, ...zxy] = match;
      const meta = await getMeta(table);
      if (!meta) break;
      const [type, body] = await handlers[name](meta, table, ...zxy.map(Number));
      res.writeHead(200, { 'Content-Type': type });
      return res.end(body);
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    console.error(e);
    res.writeHead(500).end(e.message);
  }
}).listen(process.env.PORT ?? 3000, () => console.log(`http://localhost:${process.env.PORT ?? 3000}`));
