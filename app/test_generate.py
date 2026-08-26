import requests
import time
import hmac
import hashlib
import os
from dotenv import load_dotenv

load_dotenv("../.env")
secret = os.getenv("BACKEND_PROXY_SECRET")

user_id = "test_user_id"
role = "admin"
email = "test@example.com"
timestamp = str(int(time.time()))
payload = f"{user_id}|{timestamp}|{role}|{email}"
signature = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
auth_header = f"{payload}|{signature}"

res = requests.post(
    "http://127.0.0.1:8000/generate",
    files={"boundaryFile": ("test.kml", open("test.kml", "rb"))},
    headers={
        "X-User-Id": user_id,
        "X-User-Role": role,
        "X-User-Email": email,
        "X-Proxy-Auth": auth_header
    }
)
print(res.status_code)
print(res.text)
