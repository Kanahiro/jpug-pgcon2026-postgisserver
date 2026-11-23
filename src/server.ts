/**
 * PostGIS のテーブルを Web 地図向けに配信する最小サーバー（チュートリアル用）
 *
 * 方針: 座標変換や GeoJSON / MVT へのエンコードはすべて PostGIS（SQL）にやらせる。
 *       Node.js は「SQL を投げて、結果をそのまま HTTP で返す」だけ。
 *
 *   GET /tables.json                 配信できるテーブルの一覧
 *   GET /{table}.wkt                 WKT（1行1ジオメトリ、元の座標系のまま）
 *   GET /{table}.geojson?bbox=...    GeoJSON（EPSG:4326）。bbox=西,南,東,北（経緯度）で範囲を絞れる
 *   GET /{table}/{z}/{x}/{y}.mvt     ベクタータイル（MVT）
 *   GET /                            動作確認用ビューア（public/）
 */
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import pg from 'pg';

// ───────────────────────────────────────────────────────────────
// 1. DB 接続
// ───────────────────────────────────────────────────────────────

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/gis',
});

// ───────────────────────────────────────────────────────────────
// 2. テーブル情報の取得
//
// PostGIS は geometry カラムを持つテーブルを geometry_columns ビューで公開している。
// URL で指定されたテーブル名は、ここに載っているものだけを受け付ける。
// 「任意の文字列でテーブル名を組み立てない」ことが SQL インジェクション対策にもなる。
// ───────────────────────────────────────────────────────────────

type TableInfo = {
  geomColumn: string; // ジオメトリカラム名
  srid: number; // 座標系（EPSG コード）。typmod なしの geometry カラムだと 0
  type: string; // POINT / LINESTRING / POLYGON / GEOMETRY など
  columns: string[]; // ジオメトリ以外のカラム（＝ 地物の属性）
};

// ponytail: 一度引いたら再起動まで使い回す。テーブル定義を変えたらサーバーを再起動
const tableInfoCache = new Map<string, TableInfo>();

async function getTableInfo(table: string): Promise<TableInfo | undefined> {
  const cached = tableInfoCache.get(table);
  if (cached) return cached;

  const { rows } = await pool.query<TableInfo>(
    `SELECT g.f_geometry_column AS "geomColumn", g.srid, g.type,
       -- 属性カラムは information_schema から。geometry / geography 型は除く
       coalesce((SELECT array_agg(c.column_name::text ORDER BY c.ordinal_position)
         FROM information_schema.columns c
         WHERE c.table_schema = g.f_table_schema AND c.table_name = g.f_table_name
           AND c.udt_name NOT IN ('geometry', 'geography')), '{}') AS columns
     FROM geometry_columns g
     WHERE g.f_table_schema = 'public' AND g.f_table_name = $1
     LIMIT 1 -- ジオメトリカラムが複数あるテーブルは最初の1つだけ使う`,
    [table],
  );
  if (rows[0]) tableInfoCache.set(table, rows[0]);
  return rows[0];
}

async function listTables() {
  const { rows } = await pool.query<{ name: string; srid: number; type: string }>(
    `SELECT DISTINCT ON (f_table_name) f_table_name::text AS name, srid, type
     FROM geometry_columns
     WHERE f_table_schema = 'public'
     ORDER BY f_table_name`,
  );
  // URL のルーティング（\w+）に乗らない名前のテーブルは配信できないので除く
  return rows.filter((r) => /^\w+$/.test(r.name));
}

// ───────────────────────────────────────────────────────────────
// 3. 形式ごとの SQL
//
// SQL に値を渡すときはプレースホルダ（$1, $2, ...）を使う。
// ただしテーブル名・カラム名などの「識別子」はプレースホルダにできないので、
// pg.escapeIdentifier でダブルクォートして埋め込む（例: my"table → "my""table"）。
// ───────────────────────────────────────────────────────────────

const ident = pg.escapeIdentifier;

/** SELECT 句に並べる属性カラム。例: t."id", t."name", */
const attributeColumns = (info: TableInfo) => info.columns.map((c) => `t.${ident(c)}, `).join('');

/**
 * 座標変換に使うジオメトリ式。
 * SRID 未指定（0）だと ST_Transform が「変換元が分からない」とエラーになるので、
 * その場合は EPSG:4326（経緯度）とみなす。
 */
function geometryForTransform(info: TableInfo) {
  const geom = `t.${ident(info.geomColumn)}`;
  return info.srid === 0 ? `ST_SetSRID(${geom}, 4326)` : geom;
}

/**
 * WKT: いちばん素朴なテキスト表現。
 *   ST_AsText   ジオメトリ → 'POINT(139.76 35.68)' のような文字列
 *   string_agg  全行を改行区切りで 1 つの文字列にまとめる
 * 座標変換はしないので、テーブルの座標系の値がそのまま出る。
 */
async function toWkt(table: string, info: TableInfo): Promise<string> {
  const { rows } = await pool.query(
    `SELECT coalesce(string_agg(ST_AsText(t.${ident(info.geomColumn)}), E'\\n'), '') AS body
     FROM ${ident(table)} t`,
  );
  return rows[0].body;
}

/**
 * GeoJSON: Web 地図ライブラリがそのまま読める JSON。
 *   1. ST_Transform(geom, 4326)  経緯度に変換（GeoJSON の仕様 RFC 7946 で決まっている）
 *   2. ST_AsGeoJSON(s.*, '__geom')  1 行 → 1 Feature。
 *        '__geom' をジオメトリとして使い、それ以外のカラムは properties になる。
 *        元のジオメトリカラムを properties に混ぜないよう、サブクエリでは属性カラムだけを選んでいる。
 *   3. json_agg  Feature を配列にまとめ、json_build_object で FeatureCollection に包む
 *
 * bbox（地図の表示範囲）を渡すと、その範囲と重なる地物だけを返す。
 *   - 絞り込みは MVT と同じく「範囲のほうをテーブルの座標系に変換して &&」でインデックスを効かせる
 *   - ST_Segmentize で辺に 1 度ごとの頂点を足してから変換する。
 *       4 隅だけ変換すると、広い範囲では投影の歪みで辺が曲がる分を取りこぼす
 *       （例: 日本の平面直角座標系へ東経100〜180度を変換すると、南端が約 600km 欠ける）
 */
async function toGeoJson(table: string, info: TableInfo, bbox?: BBox): Promise<string> {
  const where = bbox
    ? `WHERE t.${ident(info.geomColumn)} &&
         ST_Transform(ST_Segmentize(ST_MakeEnvelope($1, $2, $3, $4, 4326), 1), ${Number(info.srid || 4326)})`
    : '';
  const { rows } = await pool.query(
    `SELECT json_build_object(
       'type', 'FeatureCollection',
       'features', coalesce(json_agg(ST_AsGeoJSON(s.*, '__geom')::json), '[]')
     )::text AS body
     FROM (
       SELECT ${attributeColumns(info)} ST_Transform(${geometryForTransform(info)}, 4326) AS __geom
       FROM ${ident(table)} t
       ${where}
     ) s`,
    bbox ?? ([] as number[]),
  );
  return rows[0].body;
}

type BBox = [west: number, south: number, east: number, north: number];

/**
 * クエリ文字列の bbox=西,南,東,北 を読む。未指定なら undefined、不正なら null。
 * 地図は経度 ±180 度を超えて（地球を何周も）表示できるし、Web メルカトルは緯度 ±85.05 度までなので、その範囲に収める。
 */
function parseBBox(param: string | null): BBox | null | undefined {
  if (param === null) return undefined;
  const n = param.split(',').map(Number);
  if (n.length !== 4 || !n.every(Number.isFinite)) return null;
  const lng = (v: number) => Math.min(180, Math.max(-180, v));
  const lat = (v: number) => Math.min(85.0511, Math.max(-85.0511, v));
  return [lng(n[0]), lat(n[1]), lng(n[2]), lat(n[3])];
}

/**
 * MVT（Mapbox Vector Tile）: 地図を z/x/y のタイルに区切り、表示範囲の分だけ返すバイナリ形式。
 *   1. ST_TileEnvelope(z, x, y)  タイルの範囲（Web メルカトル EPSG:3857 の矩形）
 *   2. WHERE geom && 範囲  バウンディングボックスが重なる地物だけに絞る。
 *        && は GiST インデックスが効く演算子。カラム側を変換するとインデックスが効かないので、
 *        「タイル範囲のほうをテーブルの座標系に変換」して比べるのがコツ。
 *   3. ST_AsMVTGeom  3857 に変換したジオメトリを、タイル内の座標（0〜4096）に変換し、はみ出た部分を切り取る
 *   4. ST_AsMVT  行の集まりを MVT（Protocol Buffers）にエンコード。レイヤ名はテーブル名にする
 */
async function toMvt(table: string, info: TableInfo, z: number, x: number, y: number): Promise<Buffer> {
  const srid = info.srid || 4326; // SRID 未指定は 4326 とみなす（geometryForTransform と同じ扱い）
  const { rows } = await pool.query(
    `WITH tile AS (SELECT ST_TileEnvelope($1, $2, $3) AS bounds)
     SELECT ST_AsMVT(s.*, $4::text, 4096, '__geom') AS body
     FROM (
       SELECT ${attributeColumns(info)}
              ST_AsMVTGeom(ST_Transform(${geometryForTransform(info)}, 3857), tile.bounds) AS __geom
       FROM ${ident(table)} t, tile
       WHERE t.${ident(info.geomColumn)} && ST_Transform(tile.bounds, ${Number(srid)})
     ) s`,
    [z, x, y, table],
  );
  return rows[0].body ?? Buffer.alloc(0); // 地物がないタイルは空で返す
}

// ───────────────────────────────────────────────────────────────
// 4. ルーティング（URL → どの SQL を実行するか）
// ───────────────────────────────────────────────────────────────

type Reply = { status: number; contentType: string; body: string | Buffer };
const ok = (contentType: string, body: string | Buffer): Reply => ({ status: 200, contentType, body });
const error = (status: number): Reply => ({ status, contentType: 'text/plain', body: http.STATUS_CODES[status] ?? '' });

async function route(url: URL): Promise<Reply> {
  const path = url.pathname;
  if (path === '/tables.json') return ok('application/json', JSON.stringify(await listTables()));

  // /{table}.wkt, /{table}.geojson
  // \w+ は英数字とアンダースコアだけ。パスに記号を混ぜた攻撃はここで弾かれる
  let m = path.match(/^\/(\w+)\.(wkt|geojson)$/);
  if (m) {
    const [, table, format] = m;
    const info = await getTableInfo(table);
    if (!info) return error(404);
    if (format === 'wkt') return ok('text/plain; charset=utf-8', await toWkt(table, info));
    const bbox = parseBBox(url.searchParams.get('bbox'));
    if (bbox === null) return error(400);
    return ok('application/geo+json', await toGeoJson(table, info, bbox));
  }

  // /{table}/{z}/{x}/{y}.mvt
  m = path.match(/^\/(\w+)\/(\d+)\/(\d+)\/(\d+)\.mvt$/);
  if (m) {
    const table = m[1];
    const [z, x, y] = m.slice(2).map(Number);
    // ズーム z のタイルは 2^z × 2^z 枚。範囲外の番号は ST_TileEnvelope がエラーになるので先に弾く
    if (z > 30 || x >= 2 ** z || y >= 2 ** z) return error(400);
    const info = await getTableInfo(table);
    if (!info) return error(404);
    return ok('application/vnd.mapbox-vector-tile', await toMvt(table, info, z, x, y));
  }

  return (await serveViewer(path)) ?? error(404);
}

// ───────────────────────────────────────────────────────────────
// 5. ビューアの配信（本題ではないおまけ）
// ───────────────────────────────────────────────────────────────

const publicDir = new URL('../public/', import.meta.url);
const maplibreDir = new URL('./', import.meta.resolve('maplibre-gl')); // node_modules/maplibre-gl/dist/
const MIME: Record<string, string> = { mjs: 'text/javascript', css: 'text/css', map: 'application/json' };
// ponytail: Node の実験的 API で TypeScript の型注釈を剥がすだけ。ビューアが育ったら Vite などでビルド
let viewerJs: Promise<string> | undefined;

async function serveViewer(path: string): Promise<Reply | undefined> {
  if (path === '/') return ok('text/html; charset=utf-8', await readFile(new URL('index.html', publicDir)));
  if (path === '/viewer.js') {
    viewerJs ??= readFile(new URL('viewer.ts', publicDir), 'utf8').then((src) => stripTypeScriptTypes(src));
    return ok('text/javascript', await viewerJs);
  }
  // MapLibre GL JS 本体を node_modules から配信（ファイル名を限定してディレクトリ外を読ませない）
  const m = path.match(/^\/maplibre-gl\/(maplibre-gl[\w.-]*\.(mjs|css|map))$/);
  if (m) {
    const body = await readFile(new URL(m[1], maplibreDir)).catch(() => undefined);
    return body ? ok(MIME[m[2]], body) : error(404);
  }
  return undefined;
}

// ───────────────────────────────────────────────────────────────
// 6. HTTP サーバー起動
// ───────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 3000);

http
  .createServer(async (req, res) => {
    // レスポンスタイムをログ出力（例: 200 GET /stations/14/14552/6451.mvt 3.2ms 1234B）
    const start = performance.now();
    res.on('finish', () => {
      const ms = (performance.now() - start).toFixed(1);
      console.log(`${res.statusCode} ${req.method} ${req.url} ${ms}ms ${res.getHeader('Content-Length') ?? '-'}B`);
    });

    res.setHeader('Access-Control-Allow-Origin', '*'); // 別オリジンの地図アプリからも使えるように
    try {
      const reply = await route(new URL(req.url ?? '/', 'http://localhost'));
      res.writeHead(reply.status, {
        'Content-Type': reply.contentType,
        'Content-Length': Buffer.byteLength(reply.body),
      });
      res.end(reply.body);
    } catch (e) {
      console.error(e);
      res.writeHead(500).end(http.STATUS_CODES[500]); // DB のエラー内容はクライアントに見せない
    }
  })
  .listen(port, () => console.log(`http://localhost:${port}`));
