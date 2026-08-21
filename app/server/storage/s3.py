from typing import Any, BinaryIO
from urllib.parse import quote

from botocore.exceptions import ClientError

from server.storage.base import ObjectNotFoundError, StoredObject


class S3ObjectStorage:
    """Object storage backed by an S3-compatible client."""

    def __init__(
        self,
        *,
        client: Any,
        bucket: str,
        region: str = "us-east-1",
    ) -> None:
        self._client = client
        self._bucket = bucket
        self._region = region

    def ensure_bucket(self) -> None:
        try:
            self._client.head_bucket(Bucket=self._bucket)
            return
        except ClientError as exc:
            error_code = str(exc.response.get("Error", {}).get("Code", ""))
            if error_code not in {"404", "NoSuchBucket", "NotFound"}:
                raise

        create_options: dict[str, object] = {"Bucket": self._bucket}
        if self._region != "us-east-1":
            create_options["CreateBucketConfiguration"] = {
                "LocationConstraint": self._region
            }
        self._client.create_bucket(**create_options)

    def upload(
        self,
        key: str,
        source: BinaryIO,
        *,
        content_type: str | None = None,
        content_disposition: str | None = None,
    ) -> None:
        metadata: dict[str, str] = {}
        if content_type:
            metadata["ContentType"] = content_type
        if content_disposition:
            metadata["ContentDisposition"] = content_disposition

        self._client.upload_fileobj(
            source,
            self._bucket,
            key,
            ExtraArgs=metadata,
        )

    def download(self, key: str) -> StoredObject:
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            error_code = str(exc.response.get("Error", {}).get("Code", ""))
            if error_code in {"404", "NoSuchKey", "NotFound"}:
                raise ObjectNotFoundError(key) from exc
            raise
        return StoredObject(
            body=response["Body"],
            content_length=response.get("ContentLength"),
            content_type=response.get("ContentType"),
            content_disposition=response.get("ContentDisposition"),
        )

    def delete(self, key: str) -> None:
        self._client.delete_object(Bucket=self._bucket, Key=key)

    def url_for(self, key: str) -> str:
        return f"/data/{quote(key.lstrip('/'), safe='/')}"
