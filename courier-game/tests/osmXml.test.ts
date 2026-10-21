import { describe, expect, it } from 'vitest';
import { convertOsm } from '../src/osm/convert';
import { parseOsmXml } from '../src/osm/osmXml';
import type { OsmElement } from '../src/osm/types';
import { buildTestTown } from './fixtures/testTown';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tagsXml = (tags: Record<string, string> = {}) =>
  Object.entries(tags)
    .map(([k, v]) => `    <tag k="${esc(k)}" v="${esc(v)}"/>\n`)
    .join('');

/** Writes elements the way `osmium cat -f osm` does: plain nodes, ways with <nd>, relations with <member>. */
function toOsmXml(elements: OsmElement[]): string {
  const nodes = new Map<number, string>();
  const body: string[] = [];
  for (const el of elements) {
    if (el.type === 'node') {
      const t = tagsXml(el.tags);
      nodes.set(el.id, t ? `  <node id="${el.id}" version="1" lat="${el.lat}" lon="${el.lon}">\n${t}  </node>\n` : `  <node id="${el.id}" lat="${el.lat}" lon="${el.lon}"/>\n`);
    } else if (el.type === 'way') {
      el.nodes!.forEach((id, k) => {
        const g = el.geometry![k]!;
        if (!nodes.has(id)) nodes.set(id, `  <node id="${id}" version="2" timestamp="2026-01-01T00:00:00Z" user="A &amp; B" lat="${g.lat}" lon="${g.lon}"/>\n`);
      });
      body.push(`  <way id="${el.id}">\n${el.nodes!.map((n) => `    <nd ref="${n}"/>\n`).join('')}${tagsXml(el.tags)}  </way>\n`);
    } else {
      body.push(`  <relation id="${el.id}">\n${el.members!.map((m) => `    <member type="${m.type}" ref="${m.ref}" role="${m.role}"/>\n`).join('')}${tagsXml(el.tags)}  </relation>\n`);
    }
  }
  return `<?xml version='1.0' encoding='UTF-8'?>\n<osm version="0.6" generator="test">\n${[...nodes.values()].join('')}${body.join('')}</osm>\n`;
}

describe('OSM XML input (Geofabrik extract via osmium)', () => {
  it('converts to the same map as the Overpass JSON', () => {
    const town = buildTestTown();
    const viaXml = convertOsm(parseOsmXml(toOsmXml(town.elements)), { name: 'Тестоград', bbox: town.bbox });
    const direct = convertOsm(town.elements, { name: 'Тестоград', bbox: town.bbox });
    expect(viaXml.stats).toEqual(direct.stats);
    expect(viaXml.map.roads).toEqual(direct.map.roads);
    expect(viaXml.map.water).toEqual(direct.map.water);
    expect(viaXml.map.pois.map((p) => p.name).sort()).toEqual(direct.map.pois.map((p) => p.name).sort());
    expect(viaXml.map.spawn).toEqual(direct.map.spawn);
  });

  it('unescapes entities in tag values', () => {
    const els = parseOsmXml(
      `<osm><node id="1" lat="60" lon="30"><tag k="name" v="Кафе &quot;Ёлки&quot; &amp; Co &#8470;1"/><tag k="amenity" v="cafe"/></node></osm>`,
    );
    expect(els).toEqual([{ type: 'node', id: 1, lat: 60, lon: 30, tags: { name: 'Кафе "Ёлки" & Co №1', amenity: 'cafe' } }]);
  });
});
