# FTTH Design Generator

Aplikasi web untuk membuat rancangan jaringan Fiber To The Home (FTTH) dari data boundary dan POP/OLT. Aplikasi mengambil data bangunan serta jaringan jalan dari OpenStreetMap, membuat penempatan ODC/ODP, melakukan routing kabel feeder dan distribusi, lalu mengekspor hasil ke KMZ/CSV.

## Fitur utama

- Import satu atau banyak file KML/KMZ.
- Pairing boundary–POP berdasarkan nama file atau posisi POP di dalam boundary.
- Generate Network Core: OLT/POP, ODC, ODP/tiang, feeder, dan kabel distribusi.
- Generate Homepass terpisah: titik rumah dan kabel langsung ODP → rumah.
- Kapasitas ODP maksimal mengikuti konfigurasi, default 10 rumah.
- Boundary besar diproses menggunakan tile OSM, cache, checkpoint, dan worker asynchronous.
- Progress generation berada di dalam map dan dapat dipulihkan setelah refresh.
- Banyak design dalam satu project dikelompokkan berdasarkan batch tanpa menimpa design lama.
- Export KMZ dan CSV. KML di dalam KMZ dibaca langsung oleh dashboard untuk menampilkan layer map.
- PostgreSQL + PostGIS untuk metadata project/design dan MinIO untuk file.
- Better Auth, ownership project, signed proxy header, dan audit log.

## Arsitektur

```text
Browser
  │
  ▼
Next.js Dashboard :3000
  │  proxy + session verification
  ▼
FastAPI Backend :8000 ─── PostgreSQL/PostGIS
  │                         └── project, version, audit, spatial data
  ├── Redis ─────────────── job queue + progress state
  ├── MinIO ─────────────── input/output KML, KMZ, CSV
  └── ARQ Worker ────────── proses generation maksimal 2 job paralel
```

| Komponen | Lokasi | Fungsi |
|---|---|---|
| Dashboard | `dashboard/` | Next.js, React, Deck.gl, import file, map, layer/group, progress UI |
| API | `backend/api/` | Endpoint generation, project, version, audit, file |
| Generator | `backend/services/generator/` | Parsing KML, OSM, clustering, routing, export |
| Worker | `backend/worker.py` | Menjalankan job panjang melalui ARQ/Redis |
| Database | `backend/schema.prisma` | Schema PostgreSQL/PostGIS dan metadata design |
| Storage | `backend/services/user_storage.py` | Cache lokal dan object storage MinIO |

## Alur aplikasi

### 1. Import boundary dan POP

Gunakan tombol **Import KML**. Input mendukung satu atau beberapa file `.kml`/`.kmz`.

Untuk beberapa file, sistem akan:

1. Mengklasifikasikan boundary/POP dari nama atau isi file.
2. Memasangkan basename yang sama, misalnya `area_a_boundary.kml` dengan `area_a_pop.kml`.
3. Jika nama tidak sama, mencari POP yang berada di dalam boundary.
4. Menandai boundary tanpa POP sebagai `SKIPPED`.
5. Mengirim satu job untuk setiap pasangan yang valid.

Layer preview dapat terlihat sebagai layer gabungan. Setelah generation selesai, setiap pasangan menjadi layer design sendiri di dalam group batch.

### 2. Generate Network Core

Tombol **Generate Design** menjalankan tahap Network Core. Rumah tetap diambil dari OSM untuk menentukan jumlah dan posisi ODP, tetapi titik rumah serta kabel drop tidak dimasukkan ke output core.

```text
Validasi input
  → baca boundary dan POP
  → pecah boundary menjadi tile
  → ambil/cache buildings dan road graph OSM
  → deduplikasi rumah dan filter kembali ke boundary asli
  → clustering ODP/ODC
  → routing feeder dan distribusi
  → simpan design_state + checkpoint
  → export core KMZ/CSV
  → upload output dan simpan metadata
```

Selama proses berjalan, boundary/POP dan project dikunci agar input tidak berubah di tengah job.

### 3. Generate Homepass

Setelah Network Core selesai, tombol **Generate Homepass** muncul. Tahap ini membaca cache Network Core dan tidak mengulang query OSM, clustering, atau routing utama.

Output Homepass berisi folder HC, titik rumah, kabel langsung ODP → rumah, dan file KMZ/CSV baru. Jika cache core hilang, rusak, atau berasal dari generator lama, user harus menjalankan Generate Design ulang.

### 4. Layer dan project

Design batch memakai ID internal:

```text
design:{batch_id}:{item_id}
```

Metadata menyimpan nama design, boundary, group batch, status, dan URL output. Design lama tidak dihapus ketika design baru selesai.

## Pipeline boundary besar

Boundary dipecah menjadi tile dengan overlap kecil agar query OSM tidak terlalu besar. Rumah dari overlap difilter lagi terhadap polygon boundary asli. Setiap tile menyimpan checkpoint buildings dan road graph.

Checkpoint utama:

```text
validated
osm_buildings_done
osm_roads_done
clustering_done
routing_done
core_export_done
homepass_done
```

Cache tile dipisahkan berdasarkan user, project, batch, item, dan fingerprint geometry. Retry dapat menggunakan tile yang masih valid sehingga tidak selalu mengulang seluruh query.

Cache OSM default berlaku 24 jam:

```env
OSM_CACHE_MAX_AGE_SECONDS=86400
```

Dashboard menyediakan opsi **Refresh data OSM** untuk memaksa fetch baru.

## Endpoint penting

| Method | Endpoint | Keterangan |
|---|---|---|
| `POST` | `/generate` | Generate satu design, kompatibel dengan alur lama |
| `POST` | `/generate/batch` | Membuat job dari banyak boundary/POP |
| `GET` | `/generate/batch/{batch_id}` | Status batch dan seluruh item |
| `GET` | `/generate/batch/{batch_id}/progress` | Status progress batch |
| `POST` | `/generate/batch/{batch_id}/retry/{item_id}` | Retry item batch yang gagal |
| `GET` | `/generate/progress/{job_id}` | SSE progress job |
| `GET` | `/generate/status/{job_id}` | Snapshot status untuk pemulihan setelah refresh |
| `POST` | `/generate-homepass` | Generate Homepass dari cache core |
| `POST` | `/regenerate-cables` | Regenerate kabel dari design state |
| `POST` | `/generate-custom` | Generate dari mapping KML custom |
| `GET` | `/api/files/{filename}` | Download file milik user |

Swagger tersedia di `http://localhost:8000/docs` saat backend berjalan.

## Isolasi cache dan output

```text
USER_CACHE_ROOT/
  {user_hash}/
    {project_hash}/
      {batch_hash}/
        {item_hash}/
          input/
          checkpoints/
          core/
          homepass/
          manifest.json
```

Path menggunakan hash scope, bukan input mentah user. Nama output diberi suffix item agar dua boundary bernama sama tidak saling menimpa.

## Menjalankan secara lokal

### Prasyarat

- Python 3.11+;
- Node.js 20+;
- PostgreSQL dengan PostGIS atau Docker;
- Redis;
- MinIO;
- akses internet ke OpenStreetMap/Overpass.

Install dependency backend:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Install dependency dashboard:

```bash
cd dashboard
npm install
cd ..
```

Jalankan dashboard development dari folder `dashboard/`:

```bash
npm run dev
```

Script development memakai port `3001`. Jalankan backend dari root project:

```bash
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

`backend.main` menjalankan ARQ worker lokal saat startup. Jika menjalankan worker terpisah secara manual, pastikan tidak menjalankan worker duplikat yang tidak diperlukan.

Worker manual:

```bash
arq backend.worker.WorkerSettings
```

## Deployment Docker Compose

### Prasyarat

- Docker dan Docker Compose;
- domain atau IP server;
- secret Better Auth;
- secret proxy backend;
- resource server yang cukup untuk PostgreSQL, Redis, MinIO, dan worker.

Service Compose:

- `frontend`: dashboard Next.js;
- `backend`: FastAPI;
- `worker`: ARQ generation worker;
- `redis`: queue dan progress;
- `db`: PostgreSQL + PostGIS;
- `minio`: object storage;
- `graphhopper`: routing service opsional.

### Environment backend

Buat `.env.prod` di root. Jangan commit file ini.

```env
DATABASE_URL=postgresql://postgres:password123@db:5432/ftth_db
REDIS_URL=redis://redis:6379/0

MINIO_ENDPOINT=minio:9000
MINIO_ACCESS_KEY=admin
MINIO_SECRET_KEY=ganti-password-minio
MINIO_SECURE=false

BETTER_AUTH_SECRET=secret-auth-yang-panjang
BACKEND_PROXY_SECRET=secret-proxy-acak-minimal-32-byte
REQUIRE_AUTH=true
CORS_ORIGINS=http://localhost:3000

OSM_CACHE_MAX_AGE_SECONDS=86400
MAX_BATCH_FILES=100
MAX_BATCH_FILE_BYTES=52428800
```

### Environment frontend

Buat `dashboard/.env.prod`:

```env
BETTER_AUTH_SECRET=secret-auth-yang-panjang
JWT_SECRET=secret-jwt-yang-panjang
BETTER_AUTH_URL=https://ftth.example.com
BACKEND_URL=http://backend:8000
BACKEND_PROXY_SECRET=secret-proxy-acak-yang-sama-dengan-backend
```

`BACKEND_PROXY_SECRET` harus sama di frontend dan backend. Proxy Next.js membuat signed service header; backend memvalidasi header tersebut. Jangan mengandalkan `X-User-Id` dari browser sebagai autentikasi production.

Jalankan dari root project:

```bash
docker compose up -d --build
```

Endpoint:

- Dashboard: `http://localhost:3000`;
- API docs: `http://localhost:8000/docs`;
- MinIO console: `http://localhost:9001`.

Periksa status dan log:

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f worker
docker compose logs -f frontend
```

Hentikan service:

```bash
docker compose down
```

Database dan MinIO berada di named volume. Jangan memakai `docker compose down -v` kecuali memang ingin menghapus seluruh data development.

## Keamanan production

- Set `REQUIRE_AUTH=true`.
- Gunakan `BACKEND_PROXY_SECRET` acak dan berbeda dari password database.
- Jangan expose Redis, PostgreSQL, dan MinIO ke internet publik tanpa firewall/auth tambahan.
- Ganti password default PostgreSQL dan MinIO pada `docker-compose.yml` sebelum deployment.
- Batasi `CORS_ORIGINS` hanya ke domain dashboard.
- Validasi ownership project dilakukan pada endpoint generation dan batch.
- Job, cache, dan file dibatasi berdasarkan user/project scope.
- Upload batch dibatasi jumlah file dan ukuran file.
- Path filename divalidasi untuk mencegah path traversal.
- Gunakan reverse proxy HTTPS seperti Nginx, Caddy, atau cloud load balancer.
- Backup PostgreSQL dan bucket MinIO secara berkala.

## Monitoring dan troubleshooting

### Job berhenti di 0% / `Initializing...`

```bash
docker compose logs -f worker
docker compose logs -f redis
```

Pastikan worker terhubung ke Redis dan fungsi ARQ terdaftar.

### Job berhenti di export atau 85%

Tahap tersebut biasanya sedang membuat KMZ/KML. Periksa jumlah ODP dan rumah di log worker. Untuk boundary besar, gunakan Network Core terlebih dahulu lalu Homepass terpisah.

### `Job not found`

Pastikan frontend dan backend memakai Redis database yang sama. Status progress disimpan di Redis, bukan hanya state React/browser.

### `Cache Network Core ... generator lama`

Jalankan ulang **Generate Design** untuk boundary yang dipilih. Homepass hanya dapat berjalan jika `design_state.json`, distribution geometry, dan manifest core lengkap.

### OSM lambat atau gagal

Gunakan tile/cache, kurangi ukuran boundary, atau ulangi setelah cache OSM tersedia. Opsi **Refresh data OSM** memaksa request baru dan sebaiknya tidak digunakan berulang-ulang.

### Data design tertukar

Pastikan boundary/POP tidak diganti ketika generation berjalan. Dashboard mengunci import, layer, dan pergantian project selama job aktif.

## Testing dan quality check

Backend test:

```bash
python3 -m pytest -q tests --disable-warnings
```

Compile check:

```bash
python3 -m compileall -q backend
```

Dashboard TypeScript, build, dan lint:

```bash
cd dashboard
npx tsc --noEmit
npm run build
npm run lint
```

Sebelum merge atau deploy, jalankan test backend, TypeScript check, build dashboard, dan `git diff --check`.

## Struktur output

Network Core:

```text
FTTH_{boundary}_{timestamp}_core.kmz
FTTH_{boundary}_{timestamp}_core.csv
```

Homepass:

```text
FTTH_{boundary}_{timestamp}_homepass.kmz
FTTH_{boundary}_{timestamp}_homepass.csv
```

Isi utama KMZ:

```text
OLT
LINE FD
ODC 01
  ODC
  JOIN CLOSURE
  ODP
  LINE ODC TO ODP
  HC                 # hanya Homepass
  LINE ODP TO HC     # hanya Homepass
```

## Catatan operasional

- Data OSM bersifat cache-aware dan tidak realtime. Default freshness adalah 24 jam.
- Waktu generation bergantung pada luas boundary, jumlah bangunan, ukuran road graph, Overpass, dan resource worker.
- Homepass tetap dapat memakan waktu untuk boundary dengan ribuan rumah karena export KMZ membuat feature titik dan garis dalam jumlah besar.
- Untuk banyak user, jalankan Redis, PostgreSQL, MinIO, backend, dan worker sebagai service terpisah dengan monitoring dan backup.
