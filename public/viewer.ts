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
const is = (...types: string[]): ExpressionSpecification => ['in', ['geometry-type'], ['literal', types]];

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

function render() {
  const t = tableSelect.value;
  for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource('data')) map.removeSource('data');
  wktEl.hidden = true;
  const meta = tables.find((x) => x.name === t);
  if (!meta) return;
  const mvt = fmt() === 'mvt';
  map.addSource(
    'data',
    mvt
      ? { type: 'vector', tiles: [`${location.origin}/${t}/{z}/{x}/{y}.mvt`] }
      : { type: 'geojson', data: `${location.origin}/${t}.geojson` },
  );
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
