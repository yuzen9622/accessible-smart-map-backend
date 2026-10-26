"""Value-snapshot node mapping with Float64 columns and sparse full records."""

from array import array
from bisect import bisect_left
from collections.abc import Mapping
from copy import deepcopy
from dataclasses import fields, replace
from typing import Any


def metadata_snapshot(value):
    if isinstance(value, dict):
        return {key: metadata_snapshot(item) for key, item in value.items()}
    if isinstance(value, list):
        return [metadata_snapshot(item) for item in value]
    if isinstance(value, tuple):
        return tuple(metadata_snapshot(item) for item in value)
    return deepcopy(value)


def same_value(left, right):
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            same_value(value, right[key]) for key, value in left.items()
        )
    if isinstance(left, (list, tuple)):
        return len(left) == len(right) and all(map(same_value, left, right))
    return left == right


class CompactNodeStore(Mapping):
    """Reads are independent values; mutations take effect only after assignment."""

    def __init__(self, record_type, prototype):
        self._prototype: Any = replace(prototype, attr_meta=metadata_snapshot(prototype.attr_meta))
        self._shared_fields = tuple(
            field.name for field in fields(record_type)
            if field.name not in {"osm_node_id", "lon", "lat", "attr_meta"}
        )
        self._ids = array("q")
        self._lon = array("d")
        self._lat = array("d")
        self._positions = None
        self._records: dict[int, Any] = {}

    def __len__(self):
        return len(self._ids)

    def __iter__(self):
        return iter(self._ids)

    def _position(self, key):
        if self._positions is not None:
            return self._positions.get(key)
        index = bisect_left(self._ids, key)
        if index < len(self._ids) and self._ids[index] == key:
            return index
        return None

    def __contains__(self, key):
        return self._position(key) is not None

    def __getitem__(self, key):
        index = self._position(key)
        if index is None:
            raise KeyError(key)
        node = self._records.get(key, self._prototype)
        return replace(
            node, osm_node_id=key, lon=self._lon[index], lat=self._lat[index],
            attr_meta=metadata_snapshot(node.attr_meta),
        )

    def __setitem__(self, key, node):
        if key != node.osm_node_id:
            raise ValueError("Node key must match record identity")
        index = self._position(key)
        if index is None:
            index = len(self._ids)
            if self._positions is None and self._ids and key < self._ids[-1]:
                self._positions = {value: slot for slot, value in enumerate(self._ids)}
            self._ids.append(key)
            self._lon.append(node.lon)
            self._lat.append(node.lat)
            if self._positions is not None:
                self._positions[key] = index
        else:
            self._lon[index] = node.lon
            self._lat[index] = node.lat
        if all(
            same_value(getattr(node, name), getattr(self._prototype, name))
            for name in self._shared_fields
        ) and same_value(metadata_snapshot(node.attr_meta), self._prototype.attr_meta):
            self._records.pop(key, None)
        else:
            self._records[key] = replace(node, attr_meta=metadata_snapshot(node.attr_meta))

    def retain_nodes(self, ids):
        kept_ids, lon, lat = array("q"), array("d"), array("d")
        for index, key in enumerate(self._ids):
            if key in ids:
                kept_ids.append(key)
                lon.append(self._lon[index])
                lat.append(self._lat[index])
            else:
                self._records.pop(key, None)
        self._ids, self._lon, self._lat = kept_ids, lon, lat
        if self._positions is not None:
            self._positions = {key: index for index, key in enumerate(kept_ids)}
