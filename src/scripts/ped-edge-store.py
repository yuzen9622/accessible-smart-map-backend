"""Private, replayable disk staging for generated pedestrian edges."""

import hashlib
import io
import pickle
import sqlite3
import tempfile
import zlib
from dataclasses import fields
from pathlib import Path


class _PrimitiveUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        raise ValueError("Edge staging payloads cannot load globals")


def _decode(payload):
    return _PrimitiveUnpickler(io.BytesIO(payload)).load()


class DiskEdgeStore:
    def __init__(self, record_type, batch_size=128):
        if batch_size <= 0:
            raise ValueError("batch_size must be positive")
        self.record_type = record_type
        self.batch_size = batch_size
        self._fields = tuple(
            field.name for field in fields(record_type) if field.name != "attr_meta"
        )
        self._directory = tempfile.TemporaryDirectory(prefix="ped-edges-")
        self.path = str(Path(self._directory.name) / "edges.sqlite")
        self._connection = None
        self._buffer = []
        self._buffer_bytes = 0
        self._count = 0
        try:
            self._connection = sqlite3.connect(self.path)
            self._connection.executescript("""
                PRAGMA journal_mode=OFF;
                PRAGMA synchronous=OFF;
                PRAGMA cache_size=-2048;
                PRAGMA mmap_size=0;
                PRAGMA temp_store=FILE;
                CREATE TABLE metadata (key BLOB PRIMARY KEY, payload BLOB NOT NULL) WITHOUT ROWID;
                CREATE TABLE edges (
                    ordinal INTEGER PRIMARY KEY,
                    from_node INTEGER NOT NULL,
                    to_node INTEGER NOT NULL,
                    payload BLOB NOT NULL,
                    metadata_key BLOB NOT NULL
                );
            """)
        except BaseException:
            self.close()
            raise

    def _open_connection(self):
        if self._connection is None:
            raise ValueError("Edge store is closed")
        return self._connection

    def append(self, record):
        self._open_connection()
        metadata = pickle.dumps(record.attr_meta, protocol=5)
        payload = pickle.dumps(
            tuple(getattr(record, name) for name in self._fields), protocol=5
        )
        self._buffer.append(
            (
                self._count,
                record.from_osm_node,
                record.to_osm_node,
                zlib.compress(payload),
                hashlib.sha256(metadata).digest(),
                zlib.compress(metadata),
            )
        )
        self._count += 1
        self._buffer_bytes += len(payload) + len(metadata)
        if len(self._buffer) >= self.batch_size or self._buffer_bytes >= 1024 * 1024:
            self.flush()

    def extend(self, records):
        for record in records:
            self.append(record)

    def flush(self):
        connection = self._open_connection()
        with connection:
            for ordinal, start, end, payload, key, metadata in self._buffer:
                connection.execute(
                    "INSERT OR IGNORE INTO metadata VALUES (?, ?)", (key, metadata)
                )
                stored = connection.execute(
                    "SELECT payload FROM metadata WHERE key=?", (key,)
                ).fetchone()[0]
                # Hash identity is over the original pickle, not its encoding.
                if zlib.decompress(stored) != zlib.decompress(metadata):
                    raise ValueError("Edge metadata content hash collision")
                connection.execute(
                    "INSERT INTO edges VALUES (?, ?, ?, ?, ?)",
                    (ordinal, start, end, payload, key),
                )
        self._buffer.clear()
        self._buffer_bytes = 0

    def __len__(self):
        return self._count

    def __iter__(self):
        self.flush()
        cursor = self._open_connection().execute("""
            SELECT e.payload, m.payload FROM edges e
            JOIN metadata m ON m.key=e.metadata_key ORDER BY e.ordinal
        """)
        try:
            for payload, metadata in cursor:
                # These bytes originate only in this instance's private generated store.
                yield self.record_type(
                    **dict(
                        zip(
                            self._fields, _decode(zlib.decompress(payload)), strict=True
                        )
                    ),
                    attr_meta=_decode(zlib.decompress(metadata)),
                )
        finally:
            if self._connection is not None:
                cursor.close()

    def iter_endpoints(self):
        self.flush()
        cursor = self._open_connection().execute(
            "SELECT from_node, to_node FROM edges ORDER BY ordinal"
        )
        try:
            yield from cursor
        finally:
            if self._connection is not None:
                cursor.close()

    def close(self):
        if self._connection is not None:
            self._connection.close()
            self._connection = None
        self._buffer.clear()
        self._directory.cleanup()
