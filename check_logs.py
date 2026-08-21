import urllib.request
try:
    req = urllib.request.Request('http://localhost:8000/api/generate', method='POST')
    urllib.request.urlopen(req)
except Exception as e:
    print(e)
