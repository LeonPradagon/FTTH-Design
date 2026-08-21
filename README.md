# FTTH Design Generator

Aplikasi berbasis web untuk merancang dan membuat generator desain Fiber To The Home (FTTH) menggunakan Python (FastAPI) dan Next.js. Aplikasi ini memanfaatkan OSM, Prisma, dan algoritma *clustering* AI untuk pemrosesan geospasial yang akurat.

## Arsitektur Aplikasi
- **Web**: Next.js di `app/web` (Port 3000)
- **Server**: FastAPI + Python di `app/server` (Port 8000)
- **Database**: PostgreSQL
- **Object storage**: SeaweedFS melalui API S3-compatible

```text
app/
├── server/          # FastAPI dan generator FTTH
└── web/             # Next.js
samples/
└── kml/             # Sample input KML; bukan data runtime
compose.yml
```

---

## Panduan Deployment (menggunakan Docker)

Untuk mendeploy aplikasi ini ke server production (VPS / Cloud), sangat disarankan menggunakan **Docker Compose** agar lebih stabil dan terisolasi.

### Prasyarat
1. Server Linux / Windows dengan **Docker** dan **Docker Compose** telah terinstal.
2. RAM minimal 4 GB direkomendasikan untuk menjalankan web, generator geospasial, PostgreSQL, dan SeaweedFS pada satu server.

### 1. Konfigurasi Environment (Production)
Sebelum menjalankan Docker, Anda wajib membuat file `.env.prod` khusus untuk lingkungan *production*. 

Salin file *template* ke file aslinya:
```bash
cp .env.prod.example .env.prod
```

Buka dan sesuaikan isi file **`.env.prod`** (di root folder):
```ini
POSTGRES_PASSWORD=ganti_dengan_password_acak_yang_panjang
BETTER_AUTH_SECRET=ganti_dengan_teks_acak_yang_sangat_panjang_dan_rahasia
APP_URL=https://domain-anda.example
```

### 2. Jalankan Aplikasi
Di dalam folder utama (*root*) project, jalankan konfigurasi production berikut:
```bash
docker compose --env-file .env.prod -f compose.prod.yaml up -d --build
```

Docker akan secara otomatis:
1. Mengunduh base image `python` dan `node`.
2. Melakukan instalasi seluruh *dependency* server maupun web.
3. Men-generate *client* Prisma untuk menghubungkan ke database PostgreSQL Anda.
4. Menjalankan PostgreSQL dan SeaweedFS pada jaringan internal Docker.
5. Menghidupkan *service* Server di **Port 8000** dan Web di **Port 80**.

### 3. Akses Aplikasi
Aplikasi sekarang dapat diakses melalui browser:
- **Web**: `http://<IP_SERVER_ANDA>`
- **Server API Docs (Swagger)**: `http://<IP_SERVER_ANDA>:8000/docs`

> **Penting:** Port SeaweedFS tidak dipublikasikan ke host. Objek diakses melalui route aplikasi `/data/...`.

## Penyimpanan Objek dan Migrasi ke OBS

Import permanen serta hasil KML/KMZ/CSV disimpan sebagai object key di bucket S3-compatible. Folder `app/server/data` hanya dipakai untuk scratch generator sementara; cache OSM/desain tetap berada di `app/server/cache`.

SeaweedFS menyimpan data pada named volume `seaweed_data`. Jangan menjalankan `docker compose down -v` kecuali data tersebut memang boleh dihapus, dan sertakan volume ini dalam backup server.

Untuk beralih ke Huawei OBS, ubah variabel berikut di `.env.prod`, lalu buat ulang container `server`:

```ini
STORAGE_ENDPOINT_URL=https://obs.<region>.myhuaweicloud.com
STORAGE_ACCESS_KEY_ID=<OBS access key>
STORAGE_SECRET_ACCESS_KEY=<OBS secret key>
STORAGE_BUCKET=<OBS bucket>
STORAGE_REGION=<OBS region>
STORAGE_FORCE_PATH_STYLE=false
```

Tidak ada URL SeaweedFS yang disimpan di project; format `/data/{object-key}` tetap sama saat backend berpindah ke OBS.
Kredensial `SEAWEEDFS_*` terpisah dari `STORAGE_*`, jadi access key OBS tidak diteruskan ke container SeaweedFS ketika endpoint diganti.

---

## Log & Maintenance

**Melihat Log Aplikasi:**
```bash
# Log Web
docker compose --env-file .env.prod -f compose.prod.yaml logs -f web

# Log Server
docker compose --env-file .env.prod -f compose.prod.yaml logs -f server
```

**Mematikan Aplikasi:**
```bash
docker compose --env-file .env.prod -f compose.prod.yaml down
```

**Restart Aplikasi setelah update kode:**
```bash
docker compose --env-file .env.prod -f compose.prod.yaml up -d --build
```
