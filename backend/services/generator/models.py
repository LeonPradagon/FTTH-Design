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
    # ODC-xxx for a root distribution point, or ODP-xxx when this
    # distribution point is fed through another ODP on the same ODC tree.
    upstream_id: str = None


@dataclass
class ODC:
    id: str
    lat: float
    lon: float
    odps: list = field(default_factory=list)
    splitter: Splitter = None
    closure_id: str = None
