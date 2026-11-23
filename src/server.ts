//   GET /                              検証用ビューア（public/index.html）
//   GET /tables.json                   配信可能なテーブル一覧
//   GET /{table}.wkt                   1行1ジオメトリのWKT（元のSRIDのまま）
//   GET /{table}.geojson               FeatureCollection（EPSG:4326）
//   GET /{table}/{z}/{x}/{y}.mvt       Mapbox Vector Tile（レイヤ名 = テーブル名）
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import pg from 'pg';

type Meta = { geom: string; srid: number; type: string; cols: string[] };
type Body = [contentType: string, body: string | Buffer];
type Route =
  | { kind: 'wkt'; table: string }
  | { kind: 'geojson'; table: string }
  | { kind: 'mvt'; table: string; z: number; x: number; y: number };

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/gis',
});
const q = pg.escapeIdentifier;
const publicDir = new URL('../public/', import.meta.url);
const maplibreDist = new URL('./', import.meta.resolve('maplibre-gl'));
const MIME: Record<string, string> = { mjs: 'text/javascript', css: 'text/css', map: 'application/json' };

function parseRoute(path: string): Route | undefined {
  let m = path.match(/^\/(\w+)\.(wkt|geojson)$/);
  if (m) return { kind: m[2] === 'wkt' ? 'wkt' : 'geojson', table: m[1] };
  m = path.match(/^\/(\w+)\/(\d+)\/(\d+)\/(\d+)\.mvt$/);
  if (m) return { kind: 'mvt', table: m[1], z: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
  return undefined;
}

const isValidTile = (z: number, x: number, y: number) => z <= 30 && x < 2 ** z && y < 2 ** z;

const props = (cols: string[], alias: string) => cols.map((c) => `${alias}.${q(c)}, `).join('');

// geometry_columns に載っているテーブルだけ受け付ける（SQLインジェクション対策を兼ねる）
// ponytail: 永久キャッシュ。カラム追加・テーブル再作成はサーバー再起動で反映
const metaCache = new Map<string, Meta>();
async function getMeta(table: string): Promise<Meta | undefined> {
  const cached = metaCache.get(table);
  if (cached) return cached;
  const { rows } = await pool.query<Meta>(
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

async function listTables() {
  const { rows } = await pool.query<{ name: string; srid: number; type: string }>(
    `SELECT DISTINCT ON (f_table_name) f_table_name::text AS name, srid, type
     FROM geometry_columns WHERE f_table_schema = 'public' ORDER BY f_table_name`,
  );
  return rows.filter((r) => /^\w+$/.test(r.name));
}

async function query(r: Route, m: Meta): Promise<Body> {
  const t = q(r.table);
  const g = q(m.geom);
  if (r.kind === 'wkt') {
    const { rows } = await pool.query(`SELECT coalesce(string_agg(ST_AsText(${g}), E'\\n'), '') AS body FROM ${t}`);
    return ['text/plain; charset=utf-8', rows[0].body];
  }
  if (r.kind === 'geojson') {
    const { rows } = await pool.query(
      `SELECT json_build_object('type', 'FeatureCollection', 'features',
         coalesce(json_agg(ST_AsGeoJSON(s.*, '__geom')::json), '[]'))::text AS body
       FROM (SELECT ${props(m.cols, 't')} ST_Transform(t.${g}, 4326) AS __geom FROM ${t} t) s`,
    );
    return ['application/geo+json', rows[0].body];
  }
  const { rows } = await pool.query(
    `WITH b AS (SELECT ST_TileEnvelope($1, $2, $3) AS e)
     SELECT ST_AsMVT(s.*, $4::text, 4096, '__geom') AS body FROM (
       SELECT ${props(m.cols, 't')} ST_AsMVTGeom(ST_Transform(t.${g}, 3857), b.e) AS __geom
       FROM ${t} t, b
       WHERE t.${g} && ST_Transform(b.e, ${Number(m.srid)})
     ) s`,
    [r.z, r.x, r.y, r.table],
  );
  return ['application/vnd.mapbox-vector-tile', rows[0].body ?? Buffer.alloc(0)];
}

// ponytail: Node の実験的 API で型を剥がすだけ。ビューアが育ったら Vite などのビルドへ
let viewerJs: Promise<string> | undefined;

async function handle(path: string): Promise<Body | number> {
  if (path === '/') return ['text/html; charset=utf-8', await readFile(new URL('index.html', publicDir))];
  if (path === '/viewer.js') {
    viewerJs ??= readFile(new URL('viewer.ts', publicDir), 'utf8').then((s) => stripTypeScriptTypes(s));
    return ['text/javascript', await viewerJs];
  }
  const asset = path.match(/^\/maplibre-gl\/(maplibre-gl[\w.-]*\.(mjs|css|map))$/);
  if (asset) {
    const body = await readFile(new URL(asset[1], maplibreDist)).catch(() => undefined);
    return body ? [MIME[asset[2]], body] : 404;
  }
  if (path === '/tables.json') return ['application/json', JSON.stringify(await listTables())];
  const route = parseRoute(path);
  if (!route) return 404;
  if (route.kind === 'mvt' && !isValidTile(route.z, route.x, route.y)) return 400;
  const meta = await getMeta(route.table);
  return meta ? query(route, meta) : 404;
}

const port = Number(process.env.PORT ?? 3000);

http
  .createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      const result = await handle(new URL(req.url ?? '/', 'http://x').pathname);
      if (typeof result === 'number') return res.writeHead(result).end(http.STATUS_CODES[result]);
      res.writeHead(200, { 'Content-Type': result[0] }).end(result[1]);
    } catch (e) {
      console.error(e);
      res.writeHead(500).end(http.STATUS_CODES[500]);
    }
  })
  .listen(port, () => console.log(`http://localhost:${port}`));
