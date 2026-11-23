# jpug-pgcon2026-postgisserver

PostGIS のテーブルを WKT / GeoJSON / MVT で配信する最小サーバーと、MapLibre GL JS の検証用ビューア。

Node.js 26（`.node-version`）と pnpm（`packageManager`）が必要。ローカルで PostGIS が起動している前提。

```bash
pnpm install
```

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/gis pnpm start
```

http://localhost:3000/ を開く。

| パス                                | 内容                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `/`                                 | ビューア（テーブル選択、MVT / GeoJSON 切替、タイル境界、WKT 表示、クリックで属性） |
| `/tables.json`                      | `public` スキーマの geometry テーブル一覧（名前・SRID・型）                        |
| `/{table}.wkt`                      | 1行1ジオメトリの WKT（元の SRID のまま）                                           |
| `/{table}.geojson?bbox=西,南,東,北` | FeatureCollection（EPSG:4326）。`bbox` で範囲を絞り込み（省略時は全件）            |
| `/{table}/{z}/{x}/{y}.mvt`          | Mapbox Vector Tile（レイヤ名 = テーブル名）                                        |

## 開発

```bash
pnpm check && pnpm typecheck
```
