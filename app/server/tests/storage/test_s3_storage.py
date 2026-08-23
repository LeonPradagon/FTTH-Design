from io import BytesIO

from botocore.exceptions import ClientError
import pytest

from server.storage.base import ObjectNotFoundError
from server.storage.s3 import S3ObjectStorage


class InMemoryS3Client:
    def __init__(self) -> None:
        self.buckets: set[str] = set()
        self.objects: dict[tuple[str, str], tuple[bytes, dict[str, str]]] = {}

    def head_bucket(self, *, Bucket: str) -> None:
        if Bucket not in self.buckets:
            raise ClientError(
                {"Error": {"Code": "404", "Message": "Not Found"}},
                "HeadBucket",
            )

    def create_bucket(self, **kwargs: object) -> None:
        self.buckets.add(str(kwargs["Bucket"]))

    def upload_fileobj(
        self,
        source: BytesIO,
        bucket: str,
        key: str,
        *,
        ExtraArgs: dict[str, str],
    ) -> None:
        if bucket not in self.buckets:
            raise RuntimeError("bucket does not exist")
        self.objects[(bucket, key)] = (source.read(), ExtraArgs)

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, object]:
        try:
            payload, metadata = self.objects[(Bucket, Key)]
        except KeyError as exc:
            raise ClientError(
                {"Error": {"Code": "NoSuchKey", "Message": "Not Found"}},
                "GetObject",
            ) from exc
        return {
            "Body": BytesIO(payload),
            "ContentLength": len(payload),
            "ContentType": metadata.get("ContentType"),
            "ContentDisposition": metadata.get("ContentDisposition"),
        }

    def delete_object(self, *, Bucket: str, Key: str) -> None:
        self.objects.pop((Bucket, Key), None)


def test_storage_ensures_the_configured_bucket_exists() -> None:
    client = InMemoryS3Client()
    storage = S3ObjectStorage(client=client, bucket="ftth-designs")

    storage.ensure_bucket()

    client.head_bucket(Bucket="ftth-designs")


def test_uploaded_object_can_be_downloaded_with_its_http_metadata() -> None:
    client = InMemoryS3Client()
    storage = S3ObjectStorage(client=client, bucket="ftth-designs")
    storage.ensure_bucket()

    storage.upload(
        "generated/job-1/design.kml",
        BytesIO(b"<kml>design</kml>"),
        content_type="application/vnd.google-earth.kml+xml",
        content_disposition='inline; filename="design.kml"',
    )
    stored_object = storage.download("generated/job-1/design.kml")

    assert stored_object.body.read() == b"<kml>design</kml>"
    assert stored_object.content_length == 17
    assert stored_object.content_type == "application/vnd.google-earth.kml+xml"
    assert stored_object.content_disposition == 'inline; filename="design.kml"'


def test_deleted_object_is_no_longer_downloadable() -> None:
    client = InMemoryS3Client()
    storage = S3ObjectStorage(client=client, bucket="ftth-designs")
    storage.ensure_bucket()
    storage.upload("imports/job-1/map.kml", BytesIO(b"map"))

    storage.delete("imports/job-1/map.kml")

    with pytest.raises(ObjectNotFoundError):
        storage.download("imports/job-1/map.kml")


def test_object_url_keeps_the_existing_data_route_shape() -> None:
    storage = S3ObjectStorage(
        client=InMemoryS3Client(),
        bucket="ftth-designs",
    )

    assert storage.url_for("imports/job-1/site map.kml") == (
        "/data/imports/job-1/site%20map.kml"
    )
