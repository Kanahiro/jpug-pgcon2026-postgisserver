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

| パス                       | 内容                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `/`                        | ビューア（テーブル選択、MVT / GeoJSON 切替、タイル境界、WKT 表示、クリックで属性） |
| `/tables.json`             | `public` スキーマの geometry テーブル一覧（SRID・型・カラム・EPSG:4326 の bbox）   |
| `/{table}.wkt`             | 1行1ジオメトリの WKT（元の SRID のまま）                                           |
| `/{table}.geojson`         | FeatureCollection（EPSG:4326）                                                     |
| `/{table}/{z}/{x}/{y}.mvt` | Mapbox Vector Tile（レイヤ名 = テーブル名）                                        |

## 開発

```bash
pnpm check && pnpm typecheck
```

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/gis pnpm test
```

`DATABASE_URL` が未設定だと結合テストはスキップされ、ユニットテストだけ走る。結合テストは `test_` で始まるテーブルを作って消す。
