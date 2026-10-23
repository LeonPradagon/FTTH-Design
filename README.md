# FTTH Design Generator

Aplikasi web untuk membuat rancangan jaringan Fiber To The Home (FTTH) dari data boundary dan POP/OLT. Aplikasi mengambil data bangunan serta jaringan jalan dari OpenStreetMap, membuat penempatan ODC/ODP, melakukan routing kabel feeder dan distribusi, lalu mengekspor hasil ke KMZ/CSV.

## Fitur utama

- Import satu atau banyak file KML/KMZ.
- Pairing boundary–POP berdasarkan nama file atau posisi POP di dalam boundary.
- Generate Network Core: OLT/POP, ODC, ODP/tiang, feeder, dan kabel distribusi.
- Generate Homepass terpisah: titik rumah dan kabel langsung ODP → rumah.
- Kapasitas ODP mengikuti konfigurasi, default 10 rumah.
- Job generation tersimpan di PostgreSQL dan antrean NestJS memproses maksimal dua job bersamaan.
- Progress generation berada di dalam map dan dapat dipulihkan setelah refresh.
- Banyak design dalam satu project dikelompokkan berdasarkan batch tanpa menimpa design lama.
- Export KMZ dan CSV. KML di dalam KMZ dibaca langsung oleh dashboard untuk menampilkan layer map.
- PostgreSQL + PostGIS untuk metadata project/design dan SeaweedFS untuk file.
- Better Auth, ownership project, signed proxy header, dan audit log.

### Status migrasi backend

- API NestJS menggantikan FastAPI untuk runtime lokal; Drizzle mengelola schema PostgreSQL/PostGIS yang sama.
- Job generation, progress, project, version, audit, upload, dan storage memiliki endpoint NestJS.
- Data OSM diambil dari Overpass atau dataset PostGIS aktif. Utilitas Python untuk mengimpor OSM PBF masih disimpan.
- Port generator TypeScript belum mencapai parity penuh dengan Python. Clustering berkapasitas dan ukuran minimum, centroid poligon bangunan, titik rumah dari footprint yang memotong boundary, deduplikasi koordinat rumah, snapping dan routing dari proyeksi ruas jalan termasuk biaya ruas parsial, penjarakan ODC mulai dari proyeksi ruas jalan, feeder nearest-neighbor/2-opt, routing prioritas jalan dan retry dua arah untuk jalan satu arah, cache kandidat road-walk saat penjarakan ODC, pemilihan tree distribusi berdasarkan biaya routing, pemilihan POP berdasarkan prioritas OSM, validasi radius/panjang kabel, pemeriksaan konektivitas/tree/duplikasi, normalisasi urutan dan ID ODC pada desain custom, query/cache OSM online per tile termasuk connector road, cache hasil query PostGIS lokal per boundary beserta ID bangunan per tile regional, cache graf jalan lokal berbasis data OSM dan strategi routing, checkpoint tile per job yang dapat dilanjutkan setelah restart, CSV rincian material, folder KMZ dan boundary termasuk lubang, ikon rumah KMZ mandiri, dan batch satu design dengan penggabungan polygon, pengenalan file tak berlabel, prioritas POP tertanam, serta status tanpa POP sudah dipindahkan. Optimasi routing feeder/distribusi lanjutan, beberapa aturan validasi desain custom, dan pembatalan komputasi job yang sedang berjalan masih perlu disamakan.
- Data job dan design yang sudah ada tetap di database; migrasi Drizzle bersifat aditif dan idempotent.

## Arsitektur

```text
Browser
  │
  ▼
Next.js Dashboard :3001
  │  proxy + session verification
  ▼
NestJS API :8000 ──────── PostgreSQL/PostGIS
  │                         └── project, version, audit, spatial data
  ├── Drizzle ORM ───────── schema dan query database
  ├── S3-compatible storage ─ input/output KML, KMZ, CSV
  └── generation job ─────── berjalan dalam proses NestJS
```

| Komponen | Lokasi | Fungsi |
|---|---|---|
| Dashboard | `app/web/` | Next.js, React, Deck.gl, import file, map, layer/group, progress UI |
| API | `app/nest/src/` | Endpoint generation, project, version, audit, file |
| Generator | `app/nest/src/generation/` | Parsing KML, OSM, penempatan perangkat, routing, export |
| Database | `app/nest/src/db/` | Schema Drizzle PostgreSQL/PostGIS dan metadata design |
| Storage | `app/nest/src/storage/` | Object storage S3-compatible |

> Bagian alur generator dan pipeline lama di bawah ini menjelaskan perilaku backend Python sebelum migrasi. Fitur yang belum dipindahkan belum tersedia di runtime NestJS.

NestJS dapat mengambil OSM dari Overpass atau membaca dataset lokal PostGIS yang
aktif. Routing dan pembuatan desain dilakukan di proses NestJS.

## Alur aplikasi

### 1. Import boundary dan POP

Gunakan tombol **Import KML**. Input mendukung satu atau beberapa file `.kml`/`.kmz`.

Untuk beberapa file, sistem akan:

1. Mengklasifikasikan boundary/POP dari nama atau isi file.
2. Memasangkan basename yang sama, misalnya `area_a_boundary.kml` dengan `area_a_pop.kml`.
3. Jika nama tidak sama, mencari POP yang berada di dalam boundary.
4. Menandai boundary tanpa POP sebagai `SKIPPED`.
5. Mengirim satu job untuk setiap pasangan yang valid.

Satu file KML juga boleh berisi beberapa `Polygon` yang terpisah. Dashboard
akan mengirimnya sebagai batch dan backend memecahnya menjadi satu design per
boundary, bukan menggabungkannya atau hanya memakai polygon pertama. Titik POP
dapat dikenali dari nama `POP`, `OLT`, `SENTRAL`, atau `RBS`, termasuk ketika
titik tersebut berada di file boundary yang sama.

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

Keputusan cache pada tahap ini:

1. Sistem menghitung identitas dari file boundary, file POP, konfigurasi, dan versi algoritma.
2. Jika `core_manifest.json` cocok pada scope cache yang sama dan Network Core lengkap, ODC/ODP serta jalur kabel yang sama dipakai kembali.
3. Jika input atau konfigurasi berubah, cache Network Core ditolak.
4. Pada cache miss, cache OSM tile tetap dipertahankan, tetapi clustering dan routing dijalankan ulang.
5. Opsi **Refresh data OSM** melewati cache OSM dan juga tidak menggunakan cache Network Core.

### 3. Generate Homepass

Setelah Network Core selesai, tombol **Generate Homepass** muncul. Tahap ini membaca cache Network Core dan tidak mengulang query OSM, clustering, atau routing utama.

Output Homepass berisi folder HC, titik rumah, kabel langsung ODP → rumah, dan file KMZ/CSV baru. Homepass memerlukan `design_state.json` versi lengkap beserta seluruh geometri distribusi. Jika cache core hilang, rusak, atau berasal dari generator lama, user harus menjalankan Generate Design ulang. `core_manifest.json` digunakan untuk mempercepat Generate Design berikutnya, bukan syarat utama Homepass.

### 4. Layer dan project

Design batch memakai ID internal:

```text
design:{batch_id}:{item_id}
```

Metadata menyimpan nama design, boundary, group batch, status, dan URL output. Design lama tidak dihapus ketika design baru selesai.

### Jalur kabel distribusi

Distribusi dibuat sebagai tree di dalam ODC yang sama:

```text
POP -> ODC -> ODP utama -> ODP berikutnya
```

Setiap hop harus mengikuti road graph lokal, tidak membentuk kabel lurus palsu,
tidak membentuk siklus, dan dibatasi `max_distribution_length_m` (default 500 m).
Jika ODP berdekatan serta memiliki jalan valid, ODP dapat menjadi pass-through.
Jika tidak ada jalan valid, perangkat ditandai tidak terhubung dan kabel palsu
tidak dibuat. Semua ODP tetap dihitung terhadap kapasitas ODC.

### Worker dan concurrency

Request HTTP membuat generation job di database, lalu antrean lokal NestJS
memproses maksimal dua job sekaligus. Jika NestJS berhenti, job yang belum
selesai dimasukkan lagi ke antrean saat backend menyala.
Dalam Docker, worker embedded di backend dimatikan dan service `worker` dipakai
sebagai worker terpisah. Satu worker default memproses maksimal dua job, sedangkan
pengambilan tile OSM dan clustering memiliki worker thread internal yang jumlahnya
dapat dikonfigurasi. Menambah concurrency meningkatkan throughput beberapa user,
tetapi tidak selalu mempercepat satu design; terlalu banyak worker dapat berebut
RAM/CPU dan memperlambat routing.

## Pipeline boundary besar

Boundary dipecah menjadi tile dengan overlap kecil agar query OSM tidak terlalu besar. Rumah dari overlap difilter lagi terhadap polygon boundary asli. Setiap tile menyimpan checkpoint buildings dan road graph.

Tahap progress utama:

```text
validated
osm_buildings_done
osm_roads_done
clustering_done
routing_done
core_export_done
homepass_done
```

Cache tile generation dipisahkan berdasarkan user, project, batch, item, dan fingerprint geometry. Retry dapat menggunakan tile yang masih valid sehingga tidak selalu mengulang seluruh query. Nama tahap di atas adalah status progress pipeline, sedangkan file checkpoint fisiknya berupa `.houses.json` dan `.roads.pkl` per tile.

Cache OSM default berlaku 24 jam:

```env
OSM_CACHE_MAX_AGE_SECONDS=86400
```

Dashboard menyediakan opsi **Refresh data OSM** untuk memaksa fetch baru.

### Rencana data OSM lokal skala besar

Untuk menyediakan data jalan dan gedung seluruh Indonesia secara lokal, alur
yang direkomendasikan adalah:

```text
OSM .pbf regional
  -> PostgreSQL/PostGIS (source data bersama)
  -> query jalan/gedung berdasarkan boundary + buffer POP
  -> graph NetworkX per area
  -> cache graph berdasarkan boundary dan versi data
  -> generator
```

Arsitektur ini belum aktif sebagai default. Saat ini aplikasi masih memakai
cache file lokal dan OSM/Overpass sebagai fallback. PostGIS dapat ditambahkan
kemudian tanpa mengubah output generator, selama data jalan yang diberikan ke
NetworkX tetap memiliki atribut dan geometri yang sama. Untuk seluruh Indonesia,
gunakan extract regional atau per provinsi; jangan memuat seluruh graph Indonesia
ke RAM setiap job.

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
          input/                  # batch input (jika batch)
          boundary_*.kml
          pop_*.kml
          design_state.json
          road_graph.pkl
          core_manifest.json
          checkpoints/osm_tiles/{boundary-fingerprint}/
          core/                    # output batch
          design_ftth_*.kmz
          design_ftth_*.csv
```

Path menggunakan hash scope, bukan input mentah user. Endpoint single menyimpan
input dan output langsung pada scope item, sedangkan batch menyimpan input di
`input/` dan output core di `core/`. Nama output diberi suffix timestamp/random
atau item agar dua boundary bernama sama tidak saling menimpa.

## Menjalankan secara lokal

### Prasyarat

- Node.js 20+ dan pnpm;
- PostgreSQL dengan PostGIS yang sudah tersedia secara lokal;
- S3-compatible object storage yang dikonfigurasi melalui `.env`;
- akses internet ke OpenStreetMap/Overpass untuk area kecil, atau dataset OSM PostGIS untuk area besar.

Backend NestJS memakai database yang sama dengan Better Auth. Jalankan migrasi Drizzle satu kali dari folder `app/nest/`:

```bash
cd app/nest
pnpm install
pnpm db:migrate
```

Jalankan backend lokal di port `8000`:

```bash
pnpm dev
```

Di terminal lain, jalankan dashboard Next.js lokal di port `3001`:

```bash
cd app/web
pnpm install
pnpm dev
```

## Deployment Docker Compose (konfigurasi lama)

Jangan gunakan bagian ini untuk menjalankan backend NestJS. File Compose yang
tersedia masih menjalankan FastAPI/ARQ dan belum dimigrasikan. Untuk penggunaan
lokal, ikuti langkah di atas; Docker tidak diperlukan.

### Prasyarat

- Docker dan Docker Compose;
- domain atau IP server;
- secret Better Auth;
- secret proxy backend;
- resource server yang cukup untuk PostgreSQL, Redis, SeaweedFS, dan worker.

Service Compose:

- `web`: dashboard Next.js;
- `server`: FastAPI;
- `worker`: ARQ generation worker;
- `redis`: queue dan progress;
- `db`: PostgreSQL + PostGIS;
- `seaweedfs`: object storage.

### Environment backend

Buat `.env.prod` di root. Jangan commit file ini.

```env
DATABASE_URL=postgresql://postgres:password123@db:5432/ftth_db
REDIS_URL=redis://redis:6379/0

SEAWEEDFS_ACCESS_KEY_ID=ftth-local
SEAWEEDFS_SECRET_ACCESS_KEY=ganti-secret-seaweedfs
SEAWEEDFS_BUCKET=ftth-designs
STORAGE_ENDPOINT_URL=http://seaweedfs:8333
STORAGE_ACCESS_KEY_ID=ftth-local
STORAGE_SECRET_ACCESS_KEY=ganti-secret-seaweedfs
STORAGE_BUCKET=ftth-designs

BETTER_AUTH_SECRET=secret-auth-yang-panjang
BACKEND_PROXY_SECRET=secret-proxy-acak-minimal-32-byte
CORS_ORIGINS=http://localhost:3000

OSM_CACHE_MAX_AGE_SECONDS=86400
OSM_REQUEST_TIMEOUT_SECONDS=15
OSM_TILE_WORKERS=4
OSM_NATIVE_RETRIES=3
OSM_NATIVE_SPLIT_DEPTH=2
OSM_SOURCE_MODE=auto
OSM_ONLINE_MAX_AREA_KM2=25
OSM_ONLINE_MAX_TILES=4
OSM_LOCAL_FALLBACK_ON_ONLINE_FAILURE=true
OSM_PBF_URL=https://download.geofabrik.de/asia/indonesia-latest.osm.pbf
OSM_PBF_PATH=/data/osm/indonesia-latest.osm.pbf
OSM_PBF_COVERAGE=94,-11.5,141.5,6.5
CLUSTERING_ODP_WORKERS=15
CLUSTERING_ODC_WORKERS=10
ARQ_MAX_JOBS=2
MAX_BATCH_FILES=100
MAX_BATCH_FILE_BYTES=52428800
MAX_UPLOAD_FILE_BYTES=52428800
GENERATION_RATE_LIMIT=10
GENERATION_RATE_WINDOW_SECONDS=60
```

Generator menyimpan checkpoint OSM lokal di `checkpoints/osm_tiles/` berdasarkan
fingerprint boundary. Ini adalah cache data jalan/rumah, bukan database OSM
offline penuh; tile baru tetap perlu diambil dari sumber OSM saat pertama kali
dipakai. Setelah Network Core berhasil dibuat, `core_manifest.json` menyimpan
identitas input, konfigurasi, dan versi algoritma. Generate Design dengan input
yang sama dapat langsung memakai ODC/ODP serta jalur kabel yang tersimpan,
sehingga tahap OSM, clustering, dan routing dilewati. Jika input atau konfigurasi
berubah, cache turunan otomatis ditolak dan dibuat ulang.

### Sumber data OSM online dan lokal

Mode `auto` memakai OSM/Overpass online untuk boundary kecil agar data tetap
fresh. Boundary besar memakai snapshot OSM PBF yang sudah diimport ke PostGIS
lokal sehingga Generate tidak bergantung pada timeout API. Source, dataset, dan
timestamp yang dipakai disimpan di manifest Network Core.

Update snapshot OSM dijalankan sebagai job terpisah dan tidak berjalan ketika
user menekan Generate. Contoh lokal:

```bash
docker compose --profile osm-update build
docker compose --profile osm-update run --rm osm-importer -m server.scripts.download_osm_pbf
docker compose --profile osm-update run --rm osm-importer -m server.scripts.import_osm_pbf --pbf /data/osm/indonesia-latest.osm.pbf
```

Untuk scheduler mingguan, kedua langkah tersebut dapat dijalankan sebagai satu
command yang hanya mengaktifkan dataset baru setelah import dan validasi selesai:

```bash
docker compose --profile osm-update run --rm osm-importer -m server.scripts.update_osm_dataset
```

Untuk production, gunakan file `compose.prod.yaml` dan `.env.prod`. Karena
`osm-importer` berada dalam profile `osm-update`, profile tersebut harus
diaktifkan saat build agar seluruh image, termasuk image importer, ikut dibuild:

```bash
docker compose --env-file .env.prod -f compose.prod.yaml --profile osm-update build
```

Jalankan service utama seperti biasa:

```bash
docker compose --env-file .env.prod -f compose.prod.yaml up -d
```

Jalankan update/download dan import PBF sebagai job terpisah, misalnya saat
bootstrap atau melalui scheduler mingguan:

```bash
docker compose --env-file .env.prod -f compose.prod.yaml --profile osm-update run --rm osm-importer -m server.scripts.update_osm_dataset
```

Perintah `up -d` tidak otomatis menjalankan importer. Ini disengaja karena
download/import PBF adalah proses berat dan data PBF tidak perlu dibake ke dalam
image Docker. Import baru masuk sebagai staging dan hanya menjadi aktif setelah
seluruh data berhasil diproses; jika gagal, dataset aktif sebelumnya tetap dipakai.
Importer menggunakan PostgreSQL `COPY` melalui temporary staging table untuk bulk
insert building, node jalan, edge jalan, dan POI, sehingga tidak melakukan
transaction commit untuk setiap batch kecil.

### Environment frontend

Buat `app/web/.env.prod`:

```env
BETTER_AUTH_SECRET=secret-auth-yang-panjang
JWT_SECRET=secret-jwt-yang-panjang
BETTER_AUTH_URL=https://ftth.example.com
BACKEND_URL=http://server:8000
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
- SeaweedFS tersedia di jaringan internal Docker melalui endpoint S3 port `8333`.

Periksa status dan log:

```bash
docker compose ps
docker compose logs -f server
docker compose logs -f worker
docker compose logs -f web
```

Hentikan service:

```bash
docker compose down
```

Database dan SeaweedFS berada di named volume. Jangan memakai `docker compose down -v` kecuali memang ingin menghapus seluruh data development.

## Keamanan production

- Generation mewajibkan session terautentikasi; hanya role `admin`, `engineer`, dan legacy `user` yang dapat menjalankan job.
- Gunakan `BACKEND_PROXY_SECRET` acak dan berbeda dari password database.
- Jangan expose Redis, PostgreSQL, dan SeaweedFS ke internet publik tanpa firewall/auth tambahan.
- Ganti password default PostgreSQL dan SeaweedFS pada `compose.yml` sebelum deployment.
- Batasi `CORS_ORIGINS` hanya ke domain dashboard.
- Validasi ownership project dilakukan pada endpoint generation dan batch.
- Job, cache, dan file dibatasi berdasarkan user/project scope.
- Upload batch dibatasi jumlah file dan ukuran file.
- Path filename divalidasi untuk mencegah path traversal.
- Gunakan reverse proxy HTTPS seperti Nginx, Caddy, atau cloud load balancer.
- Backup PostgreSQL dan bucket SeaweedFS secara berkala.

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

Jalankan ulang **Generate Design** untuk boundary yang dipilih. Homepass hanya dapat berjalan jika `design_state.json` versi lengkap dan seluruh geometri distribusi tersedia. Manifest core hanya diperlukan agar Generate Design identik berikutnya dapat memakai cache turunan.

### OSM lambat atau gagal

Gunakan tile/cache, kurangi ukuran boundary, atau ulangi setelah cache OSM tersedia. Opsi **Refresh data OSM** memaksa request baru dan sebaiknya tidak digunakan berulang-ulang.

### Data design tertukar

Pastikan boundary/POP tidak diganti ketika generation berjalan. Dashboard mengunci import, layer, dan pergantian project selama job aktif.

## Testing dan quality check

Backend test:

```bash
PYTHONPATH=app python3 -m pytest -q app/server/tests tests --disable-warnings
```

Compile check:

```bash
python3 -m compileall -q app/server
```

Dashboard TypeScript, build, dan lint:

```bash
cd app/web
pnpm exec tsc --noEmit
pnpm build
pnpm lint
```

Sebelum merge atau deploy, jalankan test backend, TypeScript check, build dashboard, dan `git diff --check`.

## Struktur output

Network Core single:

```text
design_ftth_{timestamp}_{random}.kmz
design_ftth_{timestamp}_{random}.csv
```

Network Core batch menggunakan pola `FTTH_{boundary}_{timestamp}_{item}_core.kmz`
dan `.csv` di folder `core/`.

Homepass:

```text
design_ftth_{timestamp}_{random}.kmz
design_ftth_{timestamp}_{random}.csv
```

Homepass single memakai pola `design_ftth_homepass_{timestamp}_{random}`.

Isi utama KMZ:

```text
BOUNDARY
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
- Untuk banyak user, jalankan Redis, PostgreSQL, SeaweedFS, backend, dan worker sebagai service terpisah dengan monitoring dan backup.
