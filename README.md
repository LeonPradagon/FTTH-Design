# FTTH Design Generator

Aplikasi berbasis web untuk merancang dan membuat generator desain Fiber To The Home (FTTH) menggunakan Python (FastAPI) dan Next.js. Aplikasi ini memanfaatkan OSM, Prisma, dan algoritma *clustering* AI untuk pemrosesan geospasial yang akurat.

## Arsitektur Aplikasi
- **Frontend**: Next.js (Port 3000)
- **Backend**: FastAPI + Python (Port 8000)
- **Database**: PostgreSQL (Eksternal)

---

## Panduan Deployment (menggunakan Docker)

Untuk mendeploy aplikasi ini ke server production (VPS / Cloud), sangat disarankan menggunakan **Docker Compose** agar lebih stabil dan terisolasi.

### Prasyarat
1. Server Linux / Windows dengan **Docker** dan **Docker Compose** telah terinstal.
2. Server Database **PostgreSQL** eksternal yang sudah menyala (contoh: Supabase, Neon, AWS RDS, atau VPS terpisah).

### 1. Konfigurasi Environment (Production)
Sebelum menjalankan Docker, Anda wajib membuat file `.env.prod` khusus untuk lingkungan *production*. 

Salin file *template* ke file aslinya:
```bash
cp .env.prod.example .env.prod
cp dashboard/.env.prod.example dashboard/.env.prod
```

Buka dan sesuaikan isi file **`.env.prod`** (di root folder):
```ini
# Ganti dengan kredensial PostgreSQL Anda yang sebenarnya
DATABASE_URL=postgresql://user:password@alamat_server:5432/ftth_db
```

Buka dan sesuaikan isi file **`dashboard/.env.prod`**:
```ini
BETTER_AUTH_SECRET=ganti_dengan_teks_acak_yang_sangat_panjang_dan_rahasia
JWT_SECRET=ganti_dengan_teks_acak_yang_sangat_panjang_dan_rahasia

# PENTING: Ganti dengan IP Publik atau Domain dari server tempat Anda melakukan deployment (Contoh: http://192.168.1.10:3000)
BETTER_AUTH_URL=http://localhost:3000
```

### 2. Jalankan Aplikasi
Di dalam folder utama (*root*) project tempat file `docker-compose.yml` berada, jalankan perintah berikut:
```bash
docker-compose up -d --build
```

Docker akan secara otomatis:
1. Mengunduh base image `python` dan `node`.
2. Melakukan instalasi seluruh *dependency* backend maupun frontend.
3. Men-generate *client* Prisma untuk menghubungkan ke database PostgreSQL Anda.
4. Menghidupkan *service* Backend di **Port 8000** dan Frontend di **Port 3000**.

### 3. Akses Aplikasi
Aplikasi sekarang dapat diakses melalui browser:
- **Frontend / Dashboard**: `http://<IP_SERVER_ANDA>:3000`
- **Backend API Docs (Swagger)**: `http://<IP_SERVER_ANDA>:8000/docs`

> **Penting:** Pastikan aturan *Firewall* (seperti `ufw` atau di pengaturan AWS/GCP Anda) sudah mengizinkan trafik masuk pada Port `3000` dan Port `8000`.

---

## Log & Maintenance

**Melihat Log Aplikasi:**
```bash
# Log Frontend
docker logs -f ftth-frontend

# Log Backend
docker logs -f ftth-backend
```

**Mematikan Aplikasi:**
```bash
docker-compose down
```

**Restart Aplikasi setelah update kode:**
```bash
docker-compose up -d --build
```
