/**
 * Minimal OSM XML reader for JOSM-saved `.osm` files.
 *
 * JOSM writes a flat, well-formed document: `<node>`, `<way>` and `<relation>`
 * elements with `<tag>`, `<nd>` and `<member>` children, attributes in single
 * or double quotes. That subset is tokenized directly instead of pulling in a
 * general XML parser. Elements JOSM marks `action="delete"` (deleted locally,
 * not yet uploaded) or `visible="false"` are dropped.
 */

export type OsmTags = Record<string, string>;

export interface OsmNode {
  id: string;
  lat: number;
  lon: number;
  tags: OsmTags;
}

export interface OsmWay {
  id: string;
  nodeIds: string[];
  tags: OsmTags;
}

export interface OsmMember {
  type: "node" | "way" | "relation";
  ref: string;
  role: string;
}

export interface OsmRelation {
  id: string;
  members: OsmMember[];
  tags: OsmTags;
}

export interface OsmData {
  nodes: Map<string, OsmNode>;
  ways: Map<string, OsmWay>;
  relations: Map<string, OsmRelation>;
}

const ELEMENT_RE = /<(\/?)(node|way|relation|nd|tag|member)\b([^>]*?)(\/?)>/g;
const ATTR_RE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * @param value Raw attribute value.
 * @returns The value with XML character and named entities decoded.
 */
function decodeEntities(value: string): string {
  return value.replace(
    /&#x([0-9a-fA-F]+);|&#(\d+);|&([a-z]+);/g,
    (match, hex: string, dec: string, name: string) => {
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      if (dec) return String.fromCodePoint(parseInt(dec, 10));
      return NAMED_ENTITIES[name] ?? match;
    },
  );
}

/**
 * @param raw Attribute source between the element name and `>`.
 * @returns Decoded attribute map.
 */
function readAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return attrs;
}

/**
 * @param attrs Element attributes.
 * @returns Whether JOSM marked the element as deleted or invisible.
 */
function isDropped(attrs: Record<string, string>): boolean {
  return attrs.action === "delete" || attrs.visible === "false";
}

/**
 * Parses a JOSM `.osm` document.
 *
 * @param xml File contents.
 * @returns Nodes, ways and relations keyed by their (possibly negative) id.
 * @throws Error when a child element appears outside its parent or a node has
 * no valid coordinate.
 */
export function parseOsmXml(xml: string): OsmData {
  const data: OsmData = {
    nodes: new Map(),
    ways: new Map(),
    relations: new Map(),
  };
  type Open =
    | { kind: "node"; el: OsmNode; dropped: boolean }
    | { kind: "way"; el: OsmWay; dropped: boolean }
    | { kind: "relation"; el: OsmRelation; dropped: boolean };
  let open: Open | null = null;

  const close = () => {
    if (!open || open.dropped) {
      open = null;
      return;
    }
    if (open.kind === "node") data.nodes.set(open.el.id, open.el);
    else if (open.kind === "way") data.ways.set(open.el.id, open.el);
    else data.relations.set(open.el.id, open.el);
    open = null;
  };

  for (const m of xml.matchAll(ELEMENT_RE)) {
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (closing) {
      if (open && open.kind === name) close();
      continue;
    }
    const attrs = readAttributes(rawAttrs);
    switch (name) {
      case "node": {
        const lat = Number(attrs.lat);
        const lon = Number(attrs.lon);
        const dropped = isDropped(attrs);
        if (!dropped && (!Number.isFinite(lat) || !Number.isFinite(lon))) {
          throw new Error(`node ${attrs.id} has no valid lat/lon`);
        }
        open = {
          kind: "node",
          el: { id: attrs.id, lat, lon, tags: {} },
          dropped,
        };
        if (selfClosing) close();
        break;
      }
      case "way":
        open = {
          kind: "way",
          el: { id: attrs.id, nodeIds: [], tags: {} },
          dropped: isDropped(attrs),
        };
        if (selfClosing) close();
        break;
      case "relation":
        open = {
          kind: "relation",
          el: { id: attrs.id, members: [], tags: {} },
          dropped: isDropped(attrs),
        };
        if (selfClosing) close();
        break;
      case "tag":
        if (!open) throw new Error(`<tag k="${attrs.k}"> outside an element`);
        open.el.tags[attrs.k] = attrs.v ?? "";
        break;
      case "nd":
        if (open?.kind !== "way") throw new Error("<nd> outside a way");
        open.el.nodeIds.push(attrs.ref);
        break;
      case "member":
        if (open?.kind !== "relation") {
          throw new Error("<member> outside a relation");
        }
        open.el.members.push({
          type: attrs.type as OsmMember["type"],
          ref: attrs.ref,
          role: attrs.role ?? "",
        });
        break;
    }
  }
  return data;
}
