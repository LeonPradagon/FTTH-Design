from minio import Minio
import os

client = Minio("localhost:9000", access_key="admin", secret_key="password123", secure=False)
client.make_bucket("test-bucket")
with open("test.txt", "w") as f:
    f.write("hello world")
client.fput_object("test-bucket", "test.txt", "test.txt")
url = client.presigned_get_object("test-bucket", "test.txt")
print("Presigned URL:", url)
