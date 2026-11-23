# jpug-pgcon2026-postgisserver

PostGIS のテーブルを WKT / GeoJSON / MVT で配信する最小サーバーと、MapLibre GL JS の検証用ビューア。

```bash
npm i
psql postgres://postgres:postgres@localhost:5432/gis -f seed.sql   # サンプルデータ（任意）
DATABASE_URL=postgres://postgres:postgres@localhost:5432/gis node server.mjs
```

http://localhost:3000/ を開く。

| パス | 内容 |
| --- | --- |
| `/` | ビューア（テーブル選択、MVT / GeoJSON 切替、タイル境界、WKT 表示、クリックで属性） |
| `/tables.json` | `public` スキーマの geometry テーブル一覧（SRID・型・カラム・EPSG:4326 の bbox） |
| `/{table}.wkt` | 1行1ジオメトリの WKT（元の SRID のまま） |
| `/{table}.geojson` | FeatureCollection（EPSG:4326） |
| `/{table}/{z}/{x}/{y}.mvt` | Mapbox Vector Tile（レイヤ名 = テーブル名） |
