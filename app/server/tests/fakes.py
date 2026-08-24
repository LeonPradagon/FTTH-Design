from io import BytesIO
from typing import BinaryIO
from urllib.parse import quote

from server.storage.base import ObjectNotFoundError, StoredObject


class InMemoryObjectStorage:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str | None, str | None]] = {}

    def ensure_bucket(self) -> None:
        pass

    def upload(
        self,
        key: str,
        source: BinaryIO,
        *,
        content_type: str | None = None,
        content_disposition: str | None = None,
    ) -> None:
        self.objects[key] = (source.read(), content_type, content_disposition)

    def download(self, key: str) -> StoredObject:
        try:
            payload, content_type, content_disposition = self.objects[key]
        except KeyError as exc:
            raise ObjectNotFoundError(key) from exc
        return StoredObject(
            body=BytesIO(payload),
            content_length=len(payload),
            content_type=content_type,
            content_disposition=content_disposition,
        )

    def delete(self, key: str) -> None:
        self.objects.pop(key, None)

    def url_for(self, key: str) -> str:
        return f"/data/{quote(key, safe='/')}"
