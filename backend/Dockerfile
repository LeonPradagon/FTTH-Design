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

# Salin kode backend
COPY backend/ ./backend/

# Pindah ke direktori backend dan generate Prisma client
WORKDIR /app/backend
RUN prisma generate

# Ekspos port backend
EXPOSE 8000

# Jalankan server
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
