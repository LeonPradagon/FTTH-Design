from dataclasses import dataclass, field

@dataclass
class Splitter:
    ratio: str
    location: str  # "ODC" atau "ODP"


@dataclass
class ODP:
    id: str
    lat: float
    lon: float
    houses: list = field(default_factory=list)
    splitter: Splitter = None


@dataclass
class ODC:
    id: str
    lat: float
    lon: float
    odps: list = field(default_factory=list)
    splitter: Splitter = None
    closure_id: str = None
