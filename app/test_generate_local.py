import asyncio
from fastapi.testclient import TestClient
from server.main import app
import os
import time
import hmac
import hashlib

secret = os.getenv("BACKEND_PROXY_SECRET", "super_secret_key")
user_id = "test_user_id"
role = "admin"
email = "test@example.com"
timestamp = str(int(time.time()))
payload = f"{user_id}|{timestamp}|{role}|{email}"
signature = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
auth_header = f"{payload}|{signature}"

with open("test.kml", "w") as f:
    f.write("<kml></kml>")

client = TestClient(app)
try:
    res = client.post(
        "/generate",
        files={"boundaryFile": ("test.kml", open("test.kml", "rb"))},
        headers={
            "X-User-Id": user_id,
            "X-User-Role": role,
            "X-User-Email": email,
            "X-Proxy-Auth": auth_header
        }
    )
    print("Status:", res.status_code)
    print("Response:", res.text)
except Exception as e:
    import traceback
    traceback.print_exc()
