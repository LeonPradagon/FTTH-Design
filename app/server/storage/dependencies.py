from functools import lru_cache

import boto3
from botocore.config import Config

from server.storage.base import ObjectStorage
from server.storage.s3 import S3ObjectStorage


@lru_cache(maxsize=1)
def get_object_storage() -> ObjectStorage:
    from server.core.config import settings

    addressing_style = "path" if settings.storage_force_path_style else "virtual"
    client = boto3.client(
        "s3",
        endpoint_url=settings.storage_endpoint_url or None,
        aws_access_key_id=settings.storage_access_key_id,
        aws_secret_access_key=settings.storage_secret_access_key,
        region_name=settings.storage_region,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": addressing_style},
            retries={"max_attempts": 5, "mode": "standard"},
        ),
    )
    return S3ObjectStorage(
        client=client,
        bucket=settings.storage_bucket,
        region=settings.storage_region,
    )
