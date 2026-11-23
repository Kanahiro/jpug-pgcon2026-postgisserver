/**
 * 動作確認用ビューア（MapLibre GL JS）
 * サーバーの /tables.json でテーブル一覧を取り、選んだテーブルを MVT または GeoJSON で地図に重ねる。
 */
import type {
  CircleLayerSpecification,
  ExpressionSpecification,
  FillLayerSpecification,
  LineLayerSpecification,
} from 'maplibre-gl';
import { Map as MapLibreMap, NavigationControl, Popup } from 'maplibre-gl';

type Table = { name: string; srid: number; type: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tableSelect = $<HTMLSelectElement>('table');
const statusEl = $('status');
const wktEl = $('wkt');
const fmt = () => document.querySelector<HTMLInputElement>('[name=fmt]:checked')?.value;
const status = (msg: string, err = false) => {
  statusEl.textContent = msg;
  statusEl.className = err ? 'err' : '';
};
// 1つのテーブルに点・線・面が混ざっていても描けるよう、ジオメトリ種別ごとにレイヤを分けて filter で振り分ける
const is = (...types: string[]): ExpressionSpecification => ['in', ['geometry-type'], ['literal', types]];

// どのレイヤも 'data' ソースを描く。ソースの中身（MVT か GeoJSON か）は render() で差し替える
const LAYERS = [
  {
    id: 'fill',
    type: 'fill',
    source: 'data',
    filter: is('Polygon', 'MultiPolygon'),
    paint: { 'fill-color': '#e33', 'fill-opacity': 0.25 },
  },
  {
    id: 'line',
    type: 'line',
    source: 'data',
    filter: ['!', is('Point', 'MultiPoint')],
    paint: { 'line-color': '#c00', 'line-width': 1.5 },
  },
  {
    id: 'circle',
    type: 'circle',
    source: 'data',
    filter: is('Point', 'MultiPoint'),
    paint: { 'circle-color': '#e33', 'circle-radius': 5, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 },
  },
] satisfies (FillLayerSpecification | LineLayerSpecification | CircleLayerSpecification)[];
const layerIds = LAYERS.map((l) => l.id);
let tables: Table[] = [];

// 背景は OpenStreetMap のラスタタイル
const map = new MapLibreMap({
  container: 'map',
  center: [139.767, 35.681],
  zoom: 4,
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  },
});
map.addControl(new NavigationControl());

// 選択中のテーブル・形式で 'data' ソースを作り直す
function render() {
  const t = tableSelect.value;
  for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource('data')) map.removeSource('data');
  wktEl.hidden = true;
  const meta = tables.find((x) => x.name === t);
  if (!meta) return;
  const mvt = fmt() === 'mvt';
  // MVT: 表示範囲のタイル（/{table}/{z}/{x}/{y}.mvt）だけを都度取得する。大きなデータ向き
  // GeoJSON: テーブル全体を一度に取得する。小さなデータなら手軽
  map.addSource(
    'data',
    mvt
      ? { type: 'vector', tiles: [`${location.origin}/${t}/{z}/{x}/{y}.mvt`] }
      : { type: 'geojson', data: `${location.origin}/${t}.geojson` },
  );
  // MVT は 1 タイルに複数レイヤを持てるので、どのレイヤを描くか 'source-layer' で指定する。
  // サーバー側の ST_AsMVT でレイヤ名をテーブル名にしているので、ここもテーブル名
  for (const l of LAYERS) map.addLayer(mvt ? { ...l, 'source-layer': t } : l);
  status(`${t}: ${meta.type} / EPSG:${meta.srid} / ${mvt ? 'MVT' : 'GeoJSON'}`);
}

map.on('load', async () => {
  try {
    tables = await (await fetch('/tables.json')).json();
  } catch (e) {
    return status(`/tables.json の取得に失敗: ${(e as Error).message}`, true);
  }
  if (!tables.length) return status('geometry_columns に public スキーマのテーブルがありません', true);
  tableSelect.replaceChildren(...tables.map((t) => new Option(t.name)));
  tableSelect.onchange = render;
  render();
});

for (const el of document.querySelectorAll<HTMLInputElement>('[name=fmt]')) el.onchange = render;
// タイル境界を表示すると、MVT がタイル単位で読み込まれている様子が見える
$<HTMLInputElement>('tiles').onchange = (e) => {
  map.showTileBoundaries = (e.target as HTMLInputElement).checked;
};

$('wktBtn').onclick = async () => {
  if (!wktEl.hidden) {
    wktEl.hidden = true;
    return;
  }
  const text = await (await fetch(`/${tableSelect.value}.wkt`)).text();
  // ponytail: 巨大テーブルでブラウザが固まらないよう先頭だけ表示
  wktEl.textContent = text.length > 100000 ? `${text.slice(0, 100000)}\n…(truncated)` : text;
  wktEl.hidden = false;
};

map.on('error', (e) => {
  if ((e as { sourceId?: string }).sourceId !== 'osm') status(e.error?.message ?? String(e), true);
});

// クリックした地物の属性（＝ テーブルのジオメトリ以外のカラム）をポップアップ表示
map.on('click', (e) => {
  const f = map.queryRenderedFeatures(e.point, { layers: layerIds })[0];
  if (!f) return;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(f.properties, null, 2);
  new Popup().setLngLat(e.lngLat).setDOMContent(pre).addTo(map);
});
for (const id of layerIds) {
  map.on('mouseenter', id, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', id, () => {
    map.getCanvas().style.cursor = '';
  });
}
