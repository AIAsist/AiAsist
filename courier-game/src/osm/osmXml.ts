// Reads OSM XML (as written by `osmium cat -f osm`) into the same element shape the Overpass API
// returns with `out body geom`: ways carry their node coordinates, relation members their way geometry.

import type { LatLon, OsmElement, OsmMember, OsmNode, OsmRelation, OsmWay, Tags } from './types';

const ENTITIES: Record<string, string> = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };

function unescapeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

export function parseOsmXml(xml: string): OsmElement[] {
  const coords = new Map<number, [number, number]>();
  const taggedNodes: OsmNode[] = [];
  const ways = new Map<number, { id: number; nodes: number[]; tags: Tags }>();
  const relations: { id: number; members: OsmMember[]; tags: Tags }[] = [];

  type Open =
    | { kind: 'node'; id: number; lat: number; lon: number; tags: Tags }
    | { kind: 'way'; id: number; nodes: number[]; tags: Tags }
    | { kind: 'relation'; id: number; members: OsmMember[]; tags: Tags };
  let cur: Open | null = null;

  const close = () => {
    if (!cur) return;
    if (cur.kind === 'node') {
      if (Object.keys(cur.tags).length) taggedNodes.push({ type: 'node', id: cur.id, lat: cur.lat, lon: cur.lon, tags: cur.tags });
    } else if (cur.kind === 'way') {
      ways.set(cur.id, { id: cur.id, nodes: cur.nodes, tags: cur.tags });
    } else {
      relations.push({ id: cur.id, members: cur.members, tags: cur.tags });
    }
    cur = null;
  };

  for (const m of xml.matchAll(/<(\/?)(node|way|relation|nd|member|tag)\b([^>]*?)(\/?)>/g)) {
    const [, closing, name, body, selfClosing] = m;
    if (closing) {
      close();
      continue;
    }
    const a = attrs(body);
    switch (name) {
      case 'node': {
        const id = Number(a.id);
        const lat = Number(a.lat);
        const lon = Number(a.lon);
        coords.set(id, [lat, lon]);
        cur = { kind: 'node', id, lat, lon, tags: {} };
        break;
      }
      case 'way':
        cur = { kind: 'way', id: Number(a.id), nodes: [], tags: {} };
        break;
      case 'relation':
        cur = { kind: 'relation', id: Number(a.id), members: [], tags: {} };
        break;
      case 'nd':
        if (cur?.kind === 'way') cur.nodes.push(Number(a.ref));
        break;
      case 'member':
        if (cur?.kind === 'relation') cur.members.push({ type: a.type as OsmMember['type'], ref: Number(a.ref), role: a.role ?? '' });
        break;
      case 'tag':
        if (cur) cur.tags[a.k] = a.v;
        break;
    }
    if (selfClosing && (name === 'node' || name === 'way' || name === 'relation')) close();
  }
  close();

  const geometryOf = (nodeIds: number[]): LatLon[] =>
    nodeIds.map((id) => {
      const c = coords.get(id);
      return c ? { lat: c[0], lon: c[1] } : null;
    });

  const out: OsmElement[] = [...taggedNodes];
  for (const w of ways.values()) {
    if (!Object.keys(w.tags).length) continue; // untagged ways only matter as relation members
    const way: OsmWay = { type: 'way', id: w.id, nodes: w.nodes, geometry: geometryOf(w.nodes), tags: w.tags };
    out.push(way);
  }
  for (const r of relations) {
    const rel: OsmRelation = {
      type: 'relation',
      id: r.id,
      tags: r.tags,
      members: r.members.map((mem) => {
        const w = mem.type === 'way' ? ways.get(mem.ref) : undefined;
        return w ? { ...mem, geometry: geometryOf(w.nodes) } : mem;
      }),
    };
    out.push(rel);
  }
  return out;
}
