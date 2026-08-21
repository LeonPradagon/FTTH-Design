from dataclasses import dataclass
from typing import BinaryIO, Protocol


class ObjectNotFoundError(Exception):
    """Raised when an object key does not exist in storage."""


@dataclass(frozen=True)
class StoredObject:
    body: BinaryIO
    content_length: int | None
    content_type: str | None
    content_disposition: str | None


class ObjectStorage(Protocol):
    def ensure_bucket(self) -> None: ...

    def upload(
        self,
        key: str,
        source: BinaryIO,
        *,
        content_type: str | None = None,
        content_disposition: str | None = None,
    ) -> None: ...

    def download(self, key: str) -> StoredObject: ...

    def delete(self, key: str) -> None: ...

    def url_for(self, key: str) -> str: ...
