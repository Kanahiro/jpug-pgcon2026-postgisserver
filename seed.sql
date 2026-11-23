-- 動作確認用サンプルデータ: psql "$DATABASE_URL" -f seed.sql
-- SRID の違う3テーブル（4326 点 / 6677 ポリゴン / 3857 ライン）で座標変換まわりを確認できる
CREATE EXTENSION IF NOT EXISTS postgis;

DROP TABLE IF EXISTS stations, parcels, routes;

CREATE TABLE stations (id serial PRIMARY KEY, name text, passengers int, geom geometry(Point, 4326));
INSERT INTO stations (name, passengers, geom) VALUES
  ('東京', 462589, ST_SetSRID(ST_MakePoint(139.7671, 35.6812), 4326)),
  ('新宿', 650602, ST_SetSRID(ST_MakePoint(139.7005, 35.6896), 4326)),
  ('渋谷', 366128, ST_SetSRID(ST_MakePoint(139.7016, 35.6580), 4326)),
  ('池袋', 559920, ST_SetSRID(ST_MakePoint(139.7109, 35.7295), 4326)),
  ('品川', 377337, ST_SetSRID(ST_MakePoint(139.7387, 35.6285), 4326));

-- JGD2011 平面直角座標系 第IX系。東京駅周辺に 200m 角のグリッド
CREATE TABLE parcels (id serial PRIMARY KEY, code text, area_m2 double precision, geom geometry(Polygon, 6677));
INSERT INTO parcels (code, area_m2, geom)
SELECT format('P-%s-%s', i, j), 200 * 200,
       ST_MakeEnvelope(o.x + i * 200, o.y + j * 200, o.x + (i + 1) * 200, o.y + (j + 1) * 200, 6677)
FROM (SELECT ST_X(p) - 1000 AS x, ST_Y(p) - 1000 AS y
      FROM ST_Transform(ST_SetSRID(ST_MakePoint(139.7671, 35.6812), 4326), 6677) p) o,
     generate_series(0, 9) i, generate_series(0, 9) j;

CREATE TABLE routes (id serial PRIMARY KEY, name text, geom geometry(LineString, 3857));
INSERT INTO routes (name, geom)
SELECT '新宿-東京', ST_Transform(ST_MakeLine(a.geom, b.geom), 3857) FROM stations a, stations b WHERE a.name = '新宿' AND b.name = '東京'
UNION ALL
SELECT '渋谷-池袋', ST_Transform(ST_MakeLine(a.geom, b.geom), 3857) FROM stations a, stations b WHERE a.name = '渋谷' AND b.name = '池袋';

CREATE INDEX ON stations USING gist (geom);
CREATE INDEX ON parcels USING gist (geom);
CREATE INDEX ON routes USING gist (geom);
