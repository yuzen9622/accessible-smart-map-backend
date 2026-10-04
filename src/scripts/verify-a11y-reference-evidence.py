#!/usr/bin/env python3
"""Read-only audit: official entrance identities, directed indoor paths and curb-ramp evidence.

Geometry proximity is never treated as verified walkability. CSVs are the official
TRTC entrance/accessibility resources, encoded CP950. Graph version is explicit.
"""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import re
import zipfile
import psycopg2
from psycopg2.extras import RealDictCursor


def distance(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    t = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon2-lon1)/2)**2
    return 6371000 * 2 * math.asin(min(1, math.sqrt(t)))


def clean(value):
    return re.sub(r'\s+', '', value).replace('臺', '台')


def exit_code(value):
    return clean(value).replace('出口', '').replace('出入口', '').upper()


def official_key(row):
    code = exit_code(row['出入口編號'])
    name = clean(row['出入口名稱'])
    station = re.sub(r'(?:出口)?' + re.escape(code) + r'$', '', name, flags=re.I)
    return station.removesuffix('站'), code


def reachable(start, adjacency, nodes):
    seen, pending = {start}, [start]
    while pending:
        node = pending.pop()
        for to in adjacency.get(node, ()):
            if nodes[to]['station_id'] != nodes[start]['station_id'] or to in seen:
                continue
            seen.add(to)
            pending.append(to)
    return sum(nodes[n]['node_type'] in (9, 10) for n in seen)


def audit(args):
    with zipfile.ZipFile(args.gtfs) as archive:
        stops = {r['stop_id']: r for r in csv.DictReader(io.TextIOWrapper(archive.open('stops.txt'), encoding='utf-8-sig'))}
    official = list(csv.DictReader(args.entrances.open(encoding='cp950', newline='')))
    elevators = list(csv.DictReader(args.accessible.open(encoding='cp950', newline='')))
    official_by_key = defaultdict(list)
    for row in official:
        official_by_key[official_key(row)].append(row)
    with psycopg2.connect(args.db_url) as conn:
        conn.set_session(readonly=True)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SET LOCAL statement_timeout='120s'")
            cur.execute("SELECT node_id,station_id,node_type,source_ref,ST_X(geom) lon,ST_Y(geom) lat FROM ped_node WHERE version_id=%s AND source_ref LIKE 'gtfs%%'", (args.version,))
            nodes = {r['node_id']: dict(r) for r in cur.fetchall()}
            cur.execute("SELECT from_node,to_node,edge_type FROM ped_edge WHERE version_id=%s AND edge_type IN (20,22,24,25,26)", (args.version,))
            forward, reverse = defaultdict(set), defaultdict(set)
            for row in cur.fetchall():
                forward[row['from_node']].add(row['to_node'])
                reverse[row['to_node']].add(row['from_node'])
            cur.execute("SELECT node_id,objectid FROM ped_ramp_node WHERE version_id=%s", (args.version,))
            ramps = defaultdict(set)
            for row in cur.fetchall():
                ramps[row['node_id']].add(row['objectid'])
            cur.execute("SELECT edge_id,from_node,to_node,length_m,source_ref,ST_AsGeoJSON(geom)::json geometry FROM ped_edge WHERE version_id=%s AND edge_type=3", (args.version,))
            crossing_rows = [dict(r) for r in cur.fetchall()]
    entrances = []
    for n in nodes.values():
        if n['node_type'] != 11:
            continue
        stop = stops.get(n['source_ref'].split(':')[-1], {})
        station = stops.get(n['station_id'], {}).get('stop_name', '')
        key = clean(station).removesuffix('站'), exit_code(stop.get('stop_name', ''))
        candidates = official_by_key.get(key, [])
        matches = sorted([(distance((n['lon'], n['lat']), (float(r['經度']), float(r['緯度']))), r) for r in candidates], key=lambda x:x[0])
        nearest = min(official, key=lambda r:distance((n['lon'],n['lat']), (float(r['經度']),float(r['緯度']))))
        e_nearest = min(elevators,key=lambda r:distance((n['lon'],n['lat']), (float(r['經度']),float(r['緯度']))))
        row = {**n, 'station_name':station,'exit_name':stop.get('stop_name'),
               'name_match_count':len(matches),'name_match_distance_m':round(matches[0][0],3) if matches else None,
               'official_accessible':matches[0][1]['是否為無障礙用'] if len(matches)==1 else None,
               'official_name':matches[0][1]['出入口名稱'] if len(matches)==1 else None,
               'nearest_official_distance_m':round(distance((n['lon'],n['lat']),(float(nearest['經度']),float(nearest['緯度']))),3),
               'nearest_elevator_name':e_nearest['出入口電梯/無障礙坡道名稱'],
               'nearest_elevator_distance_m':round(distance((n['lon'],n['lat']),(float(e_nearest['經度']),float(e_nearest['緯度']))),3),
               'step_free_ingress_platforms':reachable(n['node_id'],forward,nodes),
               'step_free_egress_platforms':reachable(n['node_id'],reverse,nodes)}
        row['identity_corroborated'] = len(matches)==1 and matches[0][0]<=15
        entrances.append(row)
    # Physical crossing components use all crossing edges, not only shared-point
    # segments. Degree-2 chains can be split OSM lines; branched groups are ambiguous.
    physical = {}
    adjacent = defaultdict(set)
    for e in crossing_rows:
        key = tuple(sorted((e['from_node'],e['to_node'])))
        physical.setdefault(key,e)
        adjacent[key[0]].add(key[1]); adjacent[key[1]].add(key[0])
    component_of, components = {}, []
    for start in adjacent:
        if start in component_of:continue
        component_id=len(components); pending=[start]; member=set()
        while pending:
            n=pending.pop()
            if n in member:continue
            member.add(n); component_of[n]=component_id
            pending.extend(adjacent[n]-member)
        ends=[n for n in member if len(adjacent[n])==1]
        simple=len(ends)==2 and all(len(adjacent[n])<=2 for n in member)
        distinct=simple and bool(ramps[ends[0]]) and bool(ramps[ends[1]]) and len(ramps[ends[0]]|ramps[ends[1]])>=2
        same=simple and bool(ramps[ends[0]] & ramps[ends[1]]) and not distinct
        components.append({'nodes':len(member),'simple_chain':simple,'distinct_endpoint_ramps':bool(distinct),'same_only_endpoint_ramp':bool(same)})
    shared_rows=[]; classification=Counter()
    for e in crossing_rows:
        a,b=ramps[e['from_node']],ramps[e['to_node']]
        if not a or not b or len(a|b)!=1:continue
        comp=components[component_of[e['from_node']]]
        if comp['simple_chain'] and comp['distinct_endpoint_ramps']: label='split_chain_with_distinct_outer_ramps'
        elif comp['same_only_endpoint_ramp']: label='whole_chain_same_point_only'
        elif comp['simple_chain']: label='whole_chain_incomplete_ramp_evidence'
        else: label='branched_or_cyclic_ambiguous'
        classification[label]+=1
        shared_rows.append({**e,'shared_objectid':next(iter(a)),'component':comp,'classification':label})
    corroborated=[e for e in entrances if e['identity_corroborated']]
    discrepancies=[e for e in corroborated if (e['official_accessible']=='是' and (not e['step_free_ingress_platforms'] or not e['step_free_egress_platforms'])) or (e['official_accessible']=='否' and (e['step_free_ingress_platforms'] or e['step_free_egress_platforms']))]
    result={'version':args.version,'scope':'read-only evidence; no source import or graph mutation',
       'input_sha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (args.entrances,args.accessible,args.gtfs)},
       'summary':{'official_entrances':len(official),'official_elevator_ramp_points':len(elevators),'graph_entrances':len(entrances),
       'name_unique_and_within_15m':len(corroborated),'corroborated_accessibility':dict(Counter(e['official_accessible'] for e in corroborated)),
       'unmatched_official_within_50m':sum(e['nearest_official_distance_m']>50 for e in entrances),
       'flag_vs_directed_path_discrepancies':len(discrepancies),'crossing_directed_edges':len(crossing_rows),
       'crossing_physical_pairs':len(physical),'same_point_only_directed_edges':len(shared_rows),'shared_edge_component_classification':dict(classification)},
       'entrances':entrances,'entrance_discrepancies':discrepancies,'same_point_crossings':shared_rows}
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result['summary'],ensure_ascii=False))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db-url',required=True);p.add_argument('--version',type=int,required=True)
    p.add_argument('--gtfs',type=Path,required=True);p.add_argument('--entrances',type=Path,required=True)
    p.add_argument('--accessible',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    audit(p.parse_args())
