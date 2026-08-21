FROM python:3.11-slim

WORKDIR /workspace

# Instal dependensi sistem yang dibutuhkan
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Salin file requirements
COPY app/server/requirements.txt .

# Instal dependensi Python
RUN pip install --no-cache-dir -r requirements.txt

# Salin kode server
COPY app/server/ ./app/server/

# Salin sample input yang dipakai ketika request tidak mengunggah boundary
COPY samples/ ./samples/

# Generate Prisma client dari schema server
RUN prisma generate --schema=app/server/schema.prisma

# Jadikan app/ sebagai Python import root sehingga package tetap bernama server
WORKDIR /workspace/app

# Ekspos port server
EXPOSE 8000

# Jalankan server
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
