import base64
import uuid
from dataclasses import asdict, dataclass
from hashlib import sha3_256
from typing import Optional, TypeVar

import cbor2
import orjson

from unchanging_ink.crypto import HashValue, Index0, PathSpec


class ConcreteTime(str):
    pass


class CompactRepr(str):
    pass


class CBORMixin:
    @classmethod
    def from_cbor(cls, data: bytes):
        return cls(**cbor2.loads(data))

    def to_cbor(self) -> bytes:
        return cbor2.dumps(asdict(self), canonical=True)


class JSONMixin:
    @classmethod
    def from_json(cls, data: bytes):
        return cls(**orjson.loads(data))

    def as_json_data(self):
        return asdict(self)

    def to_json(self) -> bytes:
        return orjson.dumps(self.as_json_data())


class HashMixin:
    def calculate_hash(self) -> HashValue:
        return sha3_256(self.to_cbor()).digest()


@dataclass
class TimestampRequest(CBORMixin, JSONMixin):
    data: str


@dataclass
class TimestampStructure(HashMixin, CBORMixin):
    data: str
    timestamp: ConcreteTime
    typ: str = "ts"
    version: str = "1"

    def calculate_hash(self) -> bytes:
        return sha3_256(self.to_cbor()).digest()


@dataclass
class IntervalProofStructure(CBORMixin, JSONMixin):
    a: PathSpec
    path: list[HashValue]
    ith: HashValue
    mth: CompactRepr
    interval_ts: ConcreteTime = None  # Time the interval was sealed and the proof generated.

    def as_json_data(self):
        data = asdict(self)
        data["path"] = [base64.b64encode(x).decode() for x in data["path"]]
        data["ith"] = base64.b64encode(data["ith"]).decode() if data["ith"] else None
        return data


@dataclass
class Timestamp(CBORMixin, JSONMixin):
    hash: HashValue
    timestamp: ConcreteTime
    typ: str = "ts"
    version: str = "1"
    proof: Optional[IntervalProofStructure] = None

    def __post_init__(self):
        if isinstance(self.proof, bytes):
            self.proof = IntervalProofStructure.from_cbor(self.proof)

    def as_json_data(self):
        data = asdict(self)
        data["hash"] = base64.b64encode(data["hash"]).decode()
        if data["proof"]:
            if "ith" in data["proof"]:
                data["proof"]["ith"] = base64.b64encode(data["proof"]["ith"]).decode()
            if "path" in data["proof"]:
                data["proof"]["path"] = [
                    base64.b64encode(x).decode() for x in data["proof"]["path"]
                ]
        return data


@dataclass
class TimestampWithId(Timestamp):
    id: Optional[uuid.UUID] = None
    interval: Optional[Index0] = None

    def as_json_data(self):
        data = super().as_json_data()
        data["id"] = str(data["id"])
        return data

    @classmethod
    def from_dict(cls, row):
        return cls(**{k: v for (k, v) in row.items() if k not in ("tag",)})


@dataclass
class Interval(HashMixin, CBORMixin, JSONMixin):
    index: Index0
    timestamp: ConcreteTime
    ith: HashValue
    version: str = "1"
    typ: str = "it"

    def as_json_data(self):
        data = asdict(self)
        data["ith"] = base64.b64encode(data["ith"]).decode()
        return data

    @classmethod
    def from_row(cls, row):
        return cls(index=row.id, timestamp=row.timestamp, ith=row.ith)


@dataclass
class MainTreeConsistencyProof(CBORMixin, JSONMixin):
    old_interval: Index0
    new_interval: Index0
    nodes: list[HashValue]
    version: str = "1"

    def as_json_data(self):
        data = asdict(self)
        data["nodes"] = [base64.b64encode(x).decode() for x in data["nodes"]]
        return data


@dataclass
class MainTreeInclusionProof(CBORMixin, JSONMixin):
    head: Index0
    leaf: Optional[Index0]
    a: PathSpec
    nodes: list[HashValue]
    version: str = "1"

    def as_json_data(self):
        data = asdict(self)
        data["nodes"] = [base64.b64encode(x).decode() for x in data["nodes"]]
        return data


@dataclass
class MainHeadBase(CBORMixin, JSONMixin):
    authority: str
    interval: Interval
    mth: HashValue
    version: str = "1"

    def as_json_data(self):
        data = asdict(self)
        data["interval"] = self.interval.as_json_data()
        data["mth"] = base64.b64encode(data["mth"]).decode()
        return data


@dataclass
class MainHead(MainHeadBase):
    inclusion: Optional[MainTreeInclusionProof] = None

    def as_json_data(self):
        data = super().as_json_data()
        data["inclusion"] = self.inclusion.as_json_data() if self.inclusion else None
        return data


@dataclass
class MainHeadWithConsistency(MainHead):
    consistency: Optional[MainTreeConsistencyProof] = None

    def as_json_data(self):
        data = super().as_json_data()
        data["consistency"] = (
            self.consistency.as_json_data() if self.consistency else None
        )
        return data
