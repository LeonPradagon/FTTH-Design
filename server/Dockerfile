FROM python:3.11-slim

WORKDIR /app

# Instal dependensi sistem yang dibutuhkan
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Salin file requirements
COPY requirements.txt .

# Instal dependensi Python
RUN pip install --no-cache-dir -r requirements.txt

# Salin kode server
COPY server/ ./server/

# Generate Prisma client dari schema server
RUN prisma generate --schema=server/schema.prisma

# Ekspos port server
EXPOSE 8000

# Jalankan server
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000"]
