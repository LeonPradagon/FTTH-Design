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
- Better Auth, ownership project, signed proxy header dengan format signature ketat, dan audit log.

### Backend NestJS

- Backend aplikasi, antrean, importer, migrasi database, dan seluruh endpoint memakai NestJS + Drizzle. Tidak ada runtime atau dependency reference implementation.
- Nest menyediakan generation core, Homepass, custom mapping, routing OSM online/lokal, import PBF, progress/cancel/recovery, batch/retry, project/version/audit, upload/download, dan object storage. Seluruh 28 route HTTP dari backend lama memiliki padanan Nest; Nest juga menyediakan health check.
- Job dan rate limit tersimpan di PostgreSQL; antrean memakai advisory lock, SSE menyediakan progress, dan cache desain versi lama tetap dapat dibaca kode Nest untuk menjaga data project.
- Uji Indonesia Mataram/Lombok menghasilkan 1.153 rumah, 29 ODC, 116 ODP; 2.626 baris CSV cocok dan 1.303 geometri KMZ cocok setelah normalisasi titik duplikat. Alur Next.js ke Nest untuk single dan batch selesai; KMZ/CSV berhasil diunduh.
- PBF Nusa Tenggara menghasilkan hitungan dan ID/geometri yang sama pada pembandingan terdahulu. Pemeriksaan menemukan 8 selisih panjang edge hingga sekitar 1 mm; pembulatan panjang per-edge sudah dihapus. Perbandingan ulang nilai panjang dan normalisasi nama kosong/null masih diperlukan setelah import dataset yang sama.
- Tes backend Nest: 91/91 lulus; build dashboard Next.js lulus. Import PBF lokal memakai skrip Nest dan memerlukan osm2pgsql 2.3.0+ serta osmium-tool untuk file yang belum terurut.
## Arsitektur

```text
Browser
  │
  ▼
Next.js Dashboard :3001
  │  proxy + session verification
  ▼
NestJS API :8001 ──────── PostgreSQL/PostGIS
  │                         └── project, version, audit, spatial data
  ├── Drizzle ORM ───────── schema dan query database
  ├── S3-compatible storage ─ input/output KML, KMZ, CSV
  └── generation job ─────── berjalan dalam proses NestJS
```

| Komponen | Lokasi | Fungsi |
|---|---|---|
| Dashboard | `app/web/` | Next.js, React, Deck.gl, import file, map, layer/group, progress UI |
| API | `app/server/src/` | Endpoint generation, project, version, audit, file |
| Generator | `app/server/src/generation/` | Parsing KML, OSM, penempatan perangkat, routing, export |
| Database | `app/server/src/db/` | Schema Drizzle PostgreSQL/PostGIS dan metadata design |
| Storage | `app/server/src/storage/` | Object storage S3-compatible |

> Detail alur di bawah menjelaskan penggunaan runtime NestJS saat ini.

Dalam mode normal (`auto`), NestJS mengecek cache tile lokal lebih dulu, lalu
mengambil Native OSM/Overpass saat cache miss, untuk boundary kecil maupun besar.
Cache tile disimpan di folder temporary sistem selama 24 jam; tidak perlu
mengunduh PBF Indonesia atau mengisi database dengan data OSM. Mode `local`
memakai dataset PostGIS secara eksplisit untuk penggunaan offline. Import PBF
bersifat opsional. Routing dan pembuatan desain dilakukan di proses NestJS.

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

Request HTTP membuat generation job di database, lalu antrean NestJS memproses
maksimal dua job bersamaan per instance. Jika API berhenti, job yang tertinggal dipulihkan setelah API aktif kembali. Advisory lock database
mencegah dua instance mengerjakan job yang sama. Pengambilan tile OSM berjalan
paralel sesuai batas konfigurasi; sesuaikan jumlah job dengan kapasitas CPU dan RAM.

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

Cache tile generation dipisahkan berdasarkan user, project, batch, item, dan fingerprint geometry. Retry dapat menggunakan tile yang masih valid sehingga tidak selalu mengulang seluruh query. Checkpoint OSM disimpan sebagai file JSON per tile.

Cache OSM default berlaku 24 jam:

```env
OSM_CACHE_MAX_AGE_SECONDS=86400
```

Dashboard menyediakan opsi **Refresh data OSM** untuk memaksa fetch baru.

### Data OSM lokal skala besar

Untuk menyediakan data jalan dan gedung seluruh Indonesia secara lokal, alur
yang direkomendasikan adalah:

```text
OSM .pbf regional
  -> importer NestJS / osm2pgsql
  -> PostgreSQL/PostGIS
  -> query jalan/gedung berdasarkan boundary + buffer POP
  -> graph jalan dan desain di NestJS
  -> generator
```

Importer dan pipeline ini berjalan dari NestJS. Untuk seluruh Indonesia,
gunakan extract regional atau per provinsi; jangan memuat seluruh data Indonesia
ke RAM untuk satu job.

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

Health check NestJS tersedia di `http://localhost:8001/health` saat backend berjalan.

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
- S3-compatible object storage, atau mode filesystem lokal untuk development;
- akses internet ke OpenStreetMap/Overpass; dataset PostGIS lokal bersifat opsional.

Backend NestJS memakai database yang sama dengan Better Auth. Jalankan migrasi Drizzle satu kali dari folder `app/server/`:

```bash
cd app/server
pnpm install
pnpm db:migrate
```

Untuk berjalan tanpa SeaweedFS/MinIO, jalankan backend dalam mode filesystem lokal di port `8001`:

```bash
STORAGE_DRIVER=local pnpm dev
```

Proxy Next.js mengarah ke `http://127.0.0.1:8001` secara default. Jika port
berbeda, atur `BACKEND_URL` di `.env` root ke alamat NestJS.

File tersimpan sementara di `USER_CACHE_ROOT` hanya bila menggunakan cache
generator; file upload/download mode lokal disimpan di `${TMPDIR}/ftth_local_storage`.
Untuk storage S3-compatible, cukup jalankan:

```bash
pnpm dev
```

Di terminal lain, jalankan dashboard Next.js lokal di port `3001`:

```bash
cd app/web
pnpm install
pnpm dev
```

## Catatan Deployment

Aplikasi lokal menggunakan Next.js dan NestJS secara langsung; Docker tidak diperlukan. File Compose opsional memakai API NestJS, migrasi Drizzle, PostgreSQL/PostGIS, dan SeaweedFS. PBF lokal diimpor dengan perintah Nest di atas; proses tersebut memerlukan `osm2pgsql 2.3.0+` dan `osmium-tool`.

## Keamanan production

- Generation mewajibkan session terautentikasi; hanya role `admin`, `engineer`, dan legacy `user` yang dapat menjalankan job.
- Gunakan `BACKEND_PROXY_SECRET` acak dan berbeda dari password database.
- Jangan expose PostgreSQL dan SeaweedFS ke internet publik tanpa firewall/auth tambahan.
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

Periksa output terminal API dan pastikan koneksi PostgreSQL/PostGIS serta object storage aktif.

### Job berhenti di export atau 85%

Tahap tersebut biasanya sedang membuat KMZ/KML. Periksa output terminal API dan jumlah ODP/rumah. Untuk boundary besar, gunakan Network Core terlebih dahulu lalu Homepass terpisah.

### `Job not found`

Status generation disimpan di PostgreSQL agar dapat dipulihkan setelah refresh dan restart API.

### `Cache Network Core ... generator lama`

Jalankan ulang **Generate Design** untuk boundary yang dipilih. Homepass hanya dapat berjalan jika `design_state.json` versi lengkap dan seluruh geometri distribusi tersedia. Manifest core hanya diperlukan agar Generate Design identik berikutnya dapat memakai cache turunan.

### OSM lambat atau gagal

Gunakan tile/cache, kurangi ukuran boundary, atau ulangi setelah cache OSM tersedia. Opsi **Refresh data OSM** memaksa request baru dan sebaiknya tidak digunakan berulang-ulang.

### Data design tertukar

Pastikan boundary/POP tidak diganti ketika generation berjalan. Dashboard mengunci import, layer, dan pergantian project selama job aktif.

## Testing dan quality check

Backend test:

```bash
cd app/server && npm test
```

Compile check:

```bash
cd app/web && pnpm build
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
- Waktu generation bergantung pada luas boundary, jumlah bangunan, ukuran road graph, Overpass, dan resource API.
- Homepass tetap dapat memakan waktu untuk boundary dengan ribuan rumah karena export KMZ membuat feature titik dan garis dalam jumlah besar.
- Untuk banyak user, jalankan PostgreSQL, SeaweedFS, dan NestJS dengan monitoring dan backup.
