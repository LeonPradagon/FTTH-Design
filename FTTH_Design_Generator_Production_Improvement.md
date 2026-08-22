# FTTH Design Generator — Production Readiness Improvement Plan

## 1. Tujuan

Dokumen ini berisi rencana improvement untuk membawa **FTTH Design Generator** menuju aplikasi yang production-ready, scalable, reliable, dan maintainable.

Arsitektur saat ini:
- Frontend: Next.js + React
- Backend: FastAPI + Python
- Database: PostgreSQL + Prisma ORM
- Data jalan: OpenStreetMap
- Generator: Capacitated Clustering + Chained Nearest-Neighbor
- Routing: road graph berbasis OpenStreetMap
- Output: KMZ dan CSV
- State/cache: `design_state.json` dan `road_graph.pkl`

Arsitektur saat ini menggunakan Next.js → FastAPI → PostgreSQL, sementara FastAPI menangani parsing KML, clustering, OSM, routing, dan rendering output. fileciteturn0file0L29-L49

---

# 2. Target Architecture

```text
                         ┌──────────────────────┐
                         │       FRONTEND       │
                         │       Next.js        │
                         │       React          │
                         │                      │
                         │ MapLibre / Map       │
                         │ Dashboard            │
                         │ Project Management   │
                         └──────────┬───────────┘
                                    │
                              HTTPS / REST
                                    │
                         ┌──────────▼───────────┐
                         │      API SERVICE     │
                         │       FastAPI        │
                         │                      │
                         │ Auth / RBAC          │
                         │ Project API          │
                         │ Generate API         │
                         │ Result API           │
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │       JOB QUEUE       │
                         │     Redis + Worker    │
                         └──────────┬───────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
       ┌──────▼──────┐       ┌──────▼──────┐      ┌──────▼──────┐
       │  Clustering │       │   Routing   │      │   Export    │
       │   Worker    │       │   Worker    │      │   Worker    │
       └──────┬──────┘       └──────┬──────┘      └──────┬──────┘
              │                     │                     │
              └─────────────────────┼─────────────────────┘
                                    │
                         ┌──────────▼───────────┐
                         │ PostgreSQL + PostGIS │
                         │      Source Truth    │
                         └──────────┬───────────┘
                                    │
                    ┌───────────────┼────────────────┐
                    │               │                │
              ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
              │  Object    │   │   Cache   │   │   OSM /   │
              │  Storage   │   │   Redis   │   │  Routing  │
              │ S3 / MinIO │   │           │   │  Service  │
              └────────────┘   └───────────┘   └───────────┘
```

---

# 3. P0 — Wajib Sebelum Production

## 3.1 Background Job / Async Generator

Jangan menjalankan seluruh generator dalam satu HTTP request.

### Current

```text
POST /generate
    ↓
FastAPI
    ↓
Parsing → Clustering → OSM → Routing → KMZ
    ↓
Response
```

### Target

```text
POST /generate
    ↓
Create Job
    ↓
202 Accepted
    ↓
Redis Queue
    ↓
Worker
    ↓
Parsing
    ↓
Clustering
    ↓
Routing
    ↓
Export
    ↓
COMPLETED
```

Gunakan:
- Redis
- Celery
- Background worker
- Retry mechanism

Status job:

```text
PENDING
PARSING
CLUSTERING
ROUTING
EXPORTING
COMPLETED
FAILED
CANCELLED
```

API yang disarankan:

```text
POST /api/projects/{project_id}/generate
GET  /api/jobs/{job_id}
POST /api/jobs/{job_id}/cancel
```

---

## 3.2 PostgreSQL + PostGIS

PostgreSQL sebaiknya menggunakan **PostGIS** untuk menjadi source of truth data geospasial.

Gunakan untuk:
- Point
- LineString
- Polygon
- spatial index
- nearest-neighbor search
- radius search
- intersection
- containment
- distance calculation

Entity utama:

```text
projects
customers
olt
odc
odp
routes
boundaries
design_versions
generation_jobs
```

Contoh:

```sql
location GEOMETRY(Point, 4326)
geometry GEOMETRY(LineString, 4326)
boundary GEOMETRY(Polygon, 4326)
```

Tambahkan spatial index pada geometry.

---

## 3.3 Database sebagai Source of Truth

`design_state.json` dan `road_graph.pkl` saat ini digunakan sebagai state/cache dan mendukung regenerate kabel tanpa mengulang clustering. fileciteturn0file0L78-L83

Untuk production:

```text
PostgreSQL + PostGIS
        ↓
SOURCE OF TRUTH
```

Sedangkan:

```text
Redis
Road Graph Cache
Temporary JSON
Temporary Files
```

hanya sebagai cache atau temporary artifact.

---

## 3.4 Object Storage

Jangan bergantung pada local filesystem aplikasi.

Gunakan:
- S3
- MinIO
- Cloudflare R2
- object storage cloud lain

Simpan:
- KML
- KMZ
- GeoJSON
- CSV
- GeoPackage
- uploaded file
- generated artifacts

Database menyimpan metadata dan object key.

Contoh:

```text
project-001/
├── input/
│   └── boundary.kmz
├── versions/
│   ├── v1/
│   │   ├── design.kmz
│   │   ├── design.geojson
│   │   └── design.csv
│   └── v2/
│       ├── design.kmz
│       ├── design.geojson
│       └── design.csv
```

---

# 4. Generator Engine

## 4.1 Parameterisasi

Algoritma saat ini menggunakan multi-tier clustering untuk mengelompokkan rumah menjadi ODP dan ODP menjadi ODC. fileciteturn0file0L11-L25

Jangan hard-code parameter.

Contoh:

```json
{
  "odp_capacity": 10,
  "odc_capacity": 4,
  "max_odp_radius_m": 150,
  "max_odc_radius_m": 500,
  "max_feeder_length_m": 2000,
  "routing_strategy": "shortest"
}
```

Parameter minimal:
- ODP capacity
- ODC capacity
- maximum ODP radius
- maximum ODC radius
- maximum feeder length
- maximum distribution length
- routing strategy
- snapping distance
- minimum/maximum cluster size

Simpan konfigurasi bersama design version.

---

## 4.2 Deterministic Generator

Input dan parameter yang sama harus menghasilkan design yang dapat direproduksi.

Simpan:

```text
input hash
algorithm version
configuration
generator version
OSM data timestamp/version
```

Target:

```text
Input
+
Configuration
+
Algorithm Version
+
OSM Version
=
Reproducible Design
```

---

## 4.3 Clustering Validation

Setelah clustering:
- validasi kapasitas ODP
- validasi kapasitas ODC
- validasi radius
- cek cluster kosong
- cek customer tidak ter-cover
- cek duplicate assignment
- cek perangkat di luar boundary

Output:

```text
PASS
WARNING
ERROR
```

---

# 5. Routing Improvement

## 5.1 Pisahkan Routing Engine

Routing dibuat sebagai module/service yang jelas:

```text
Routing Service
├── road graph
├── shortest path
├── snapping
├── route validation
└── distance calculation
```

## 5.2 Strategi OSM

Saat ini aplikasi mengambil road graph dari OpenStreetMap untuk routing. fileciteturn0file0L66-L76

Untuk production, hindari ketergantungan langsung pada public endpoint untuk seluruh traffic aplikasi.

Target:

```text
OSM
 ↓
Local / Cached Dataset
 ↓
Routing Engine
 ↓
Application
```

Pilihan routing:
- OSRM
- GraphHopper
- Valhalla

Pemilihan final harus mempertimbangkan volume request, coverage, accuracy, cost, dan update frequency.

## 5.3 Road Graph Cache

Cache berdasarkan:

```text
area / bounding box
+
OSM data version
+
routing configuration
```

---

# 6. Design Versioning

Setiap generate menghasilkan design version.

Contoh:

```text
Project: Serang Area 5

v1
ODC: 24
ODP: 91
Feeder: 12.4 km

v2
ODC: 22
ODP: 88
Feeder: 11.8 km
```

User dapat:
- melihat version
- duplicate
- regenerate
- compare
- rollback
- export

Jangan overwrite design sebelumnya.

---

# 7. Design Validation Engine

Setelah generator selesai:

```text
Generator
    ↓
Validation Engine
    ↓
PASS / WARNING / ERROR
```

Validasi hierarchy:

```text
OLT → ODC → ODP → Customer
```

Validasi connectivity:
- semua ODC terhubung ke OLT
- semua ODP terhubung ke ODC
- semua customer terhubung ke ODP
- tidak ada route disconnected

Validasi capacity:
- ODP capacity
- ODC capacity
- fiber/core capacity

Validasi geography:
- perangkat berada di boundary
- geometry valid
- snapping berhasil
- route valid

Validasi engineering:
- maximum cable length
- maximum radius
- maximum cluster size
- route crossing
- duplicate route

---

# 8. Output Format

Output minimal:

| Format | Kegunaan |
|---|---|
| KMZ | Google Earth |
| KML | Google Earth / GIS |
| GeoJSON | Web map |
| CSV | Data analysis |
| GeoPackage | GIS engineering |

Saat ini output utama adalah KMZ dan CSV. fileciteturn0file0L78-L85

---

# 9. Frontend / Dashboard

Frontend harus menjadi dashboard engineering, bukan hanya file uploader.

## Project Dashboard

Tampilkan:

```text
Project
Status
Customer Count
OLT Count
ODC Count
ODP Count
Feeder Length
Distribution Length
Generation Status
Validation Status
```

## Map Layer

```text
☑ OLT
☑ ODC
☑ ODP
☑ Customer
☑ Feeder
☑ Distribution
☑ Drop Cable
☑ Boundary
☑ Road
```

## Generator Configuration

User dapat mengubah:

```text
ODP Capacity
ODC Capacity
Maximum Radius
Maximum Cable Length
Routing Strategy
```

---

# 10. Generation Progress

Frontend harus menampilkan:

```text
Generate Design

[██████████████░░░░░░] 70%

✓ Parsing input
✓ Loading road network
✓ Clustering customers
✓ Generating ODP
✓ Generating ODC
→ Calculating routes
○ Exporting KMZ
```

Tahap awal dapat menggunakan polling. Jika dibutuhkan real-time progress, gunakan SSE atau WebSocket.

---

# 11. Authentication & Authorization

Minimal role:

```text
ADMIN
ENGINEER
VIEWER
```

Permission:

```text
ADMIN
├── create project
├── edit project
├── generate
├── delete
└── manage users

ENGINEER
├── create project
├── edit project
├── generate
└── export

VIEWER
└── view project
```

Tambahkan:
- authentication
- RBAC
- project-level authorization
- token/session expiration
- secure password hashing jika menggunakan password

---

# 12. Audit Trail

Simpan:

```text
User
Action
Project
Design Version
Timestamp
Old Value
New Value
```

Contoh:

```text
User: engineer01
Action: Changed ODP capacity
Old: 10
New: 8
Project: Serang Area 5
```

---

# 13. Error Handling

Gunakan error contract yang konsisten.

Contoh:

```json
{
  "success": false,
  "error": {
    "code": "ROUTING_FAILED",
    "message": "Unable to calculate route",
    "details": {
      "from": "ODC-004",
      "to": "ODP-018"
    }
  }
}
```

Error code:

```text
INVALID_FILE
INVALID_GEOMETRY
INVALID_BOUNDARY
NO_CUSTOMER_FOUND
CLUSTERING_FAILED
ROUTING_FAILED
EXPORT_FAILED
OSM_UNAVAILABLE
JOB_TIMEOUT
```

---

# 14. Observability

## Logging

Log minimal:
- request ID
- user ID
- project ID
- job ID
- processing duration
- error code

## Monitoring

Monitor:
- CPU
- RAM
- disk
- PostgreSQL
- Redis
- worker
- queue length
- job duration
- failed jobs
- API response time

Tools:
- Prometheus
- Grafana
- Sentry
- OpenTelemetry

---

# 15. Security

Wajib:
- HTTPS
- CORS whitelist
- input validation
- file type validation
- file size limit
- rate limiting
- SQL injection protection
- secure headers
- authentication
- authorization
- secret management
- signed download URLs
- file scanning jika upload berasal dari user eksternal

Jangan menyimpan secret di source code.

---

# 16. Backup & Recovery

PostgreSQL:
- automated backup
- retention policy
- point-in-time recovery jika diperlukan
- restore testing

Object storage:
- versioning
- lifecycle policy
- backup/replication

Backup harus diuji melalui proses restore secara berkala.

---

# 17. Testing

## Unit Test

Test:
- clustering
- centroid
- snapping
- distance
- routing
- validation
- KML/KMZ generation

## Integration Test

```text
Upload
 ↓
Parse
 ↓
Generate
 ↓
Validate
 ↓
Export
```

## Regression Test

Sediakan dataset:

```text
test-data/
├── small/
├── medium/
└── large/
```

Bandingkan:
- jumlah ODP
- jumlah ODC
- total cable length
- coverage
- validation result

---

# 18. CI/CD

Pipeline:

```text
Git Push
   ↓
Lint
   ↓
Unit Test
   ↓
Integration Test
   ↓
Build
   ↓
Security Scan
   ↓
Docker Build
   ↓
Deploy Staging
   ↓
Smoke Test
   ↓
Production
```

Environment:

```text
development
staging
production
```

---

# 19. Docker / Infrastructure

Service yang disarankan:

```text
frontend
api
worker
redis
postgres
nginx
routing
object-storage
```

Untuk tahap awal production, Docker Compose sudah cukup.

Kubernetes baru dipertimbangkan jika membutuhkan:
- worker autoscaling
- multi-node infrastructure
- high availability
- deployment yang lebih kompleks

---

# 20. Performance

Target awal:

```text
API request biasa
< 500 ms

Generate
= background job

Database
= spatial index

Map
= lazy loading / viewport query

Large dataset
= pagination / vector tiles
```

Untuk dataset besar pertimbangkan:
- server-side clustering
- spatial indexing
- bounding-box query
- vector tiles
- worker scaling
- load testing

---

# 21. Development Roadmap

## Phase 1 — Stabilize Core Engine

- [ ] Refactor generator
- [ ] Parameterisasi clustering
- [ ] Deterministic generator
- [ ] Validation engine
- [ ] Unit test
- [ ] Regression dataset

## Phase 2 — Production Backend

- [ ] PostgreSQL + PostGIS
- [ ] Redis
- [ ] Celery worker
- [ ] Async generation
- [ ] Job status
- [ ] Retry mechanism
- [ ] Error handling
- [ ] Logging

## Phase 3 — Storage

- [ ] Object storage
- [ ] Upload management
- [ ] Generated artifact management
- [ ] Signed download URL
- [ ] File retention policy

## Phase 4 — Engineering Dashboard

- [ ] Project management
- [ ] Interactive map
- [ ] Layer management
- [ ] Generator configuration
- [ ] Progress tracking
- [ ] Validation result
- [ ] Export

## Phase 5 — Design Management

- [ ] Design versioning
- [ ] Version comparison
- [ ] Duplicate design
- [ ] Rollback
- [ ] Audit trail

## Phase 6 — Routing Infrastructure

- [ ] Routing service
- [ ] OSM data strategy
- [ ] Road graph cache
- [ ] Routing fallback
- [ ] Routing monitoring

## Phase 7 — Security & Operations

- [ ] Authentication
- [ ] RBAC
- [ ] HTTPS
- [ ] Rate limiting
- [ ] Secrets management
- [ ] Monitoring
- [ ] Backup
- [ ] Disaster recovery

## Phase 8 — Scale

- [ ] Worker scaling
- [ ] Database optimization
- [ ] Spatial indexes
- [ ] Vector tiles
- [ ] Large dataset optimization
- [ ] Load testing
- [ ] Capacity planning

---

# 22. Recommended Stack

```text
Frontend
├── Next.js
├── React
├── TypeScript
└── MapLibre GL

Backend
├── FastAPI
├── Python
├── GeoPandas
├── Shapely
├── NetworkX
└── OSMnx

Async Processing
├── Celery
└── Redis

Database
├── PostgreSQL
└── PostGIS

Routing
├── OSRM / GraphHopper / Valhalla
└── Road Graph Cache

Storage
└── S3 / MinIO

Infrastructure
├── Docker
├── Nginx
├── CI/CD
└── Monitoring

Observability
├── Prometheus
├── Grafana
├── Sentry
└── OpenTelemetry
```

---

# 23. Definition of Production Ready

Aplikasi dapat dianggap production-ready ketika minimal:

- [ ] Generator tidak bergantung pada HTTP request yang panjang.
- [ ] Job dapat dipantau dan di-retry.
- [ ] PostgreSQL + PostGIS menjadi source of truth.
- [ ] File menggunakan object storage.
- [ ] Generator dapat direproduksi dengan input dan parameter yang sama.
- [ ] Design mempunyai versioning.
- [ ] Hasil mempunyai validation status.
- [ ] Routing memiliki cache/fallback dan tidak bergantung langsung pada public API.
- [ ] Authentication dan authorization diterapkan.
- [ ] Error handling konsisten.
- [ ] Logging dan monitoring tersedia.
- [ ] Database dan file memiliki backup.
- [ ] Unit, integration, dan regression test tersedia.
- [ ] CI/CD tersedia.
- [ ] Staging environment tersedia.
- [ ] Load/performance test sudah dilakukan.

---

# 24. Product Direction

Aplikasi sebaiknya berkembang dari:

> **Script untuk generate KMZ**

menjadi:

> **FTTH Network Design Platform**

End-to-end pipeline:

```text
INPUT
  ↓
VALIDATION
  ↓
GEO DATA PROCESSING
  ↓
CLUSTERING
  ↓
OLT → ODC → ODP → CUSTOMER
  ↓
ROUTING
  ↓
ENGINEERING VALIDATION
  ↓
DESIGN VERSION
  ↓
EXPORT
  ↓
GIS / GOOGLE EARTH / REPORTING
```

Target akhirnya adalah:

```text
Upload Boundary / Customer / Existing Network
                    ↓
              Configure Design
                    ↓
             Generate Network
                    ↓
         OLT → ODC → ODP → Customer
                    ↓
           Feeder + Distribution
                    ↓
          Engineering Validation
                    ↓
               Design Version
                    ↓
        ┌───────────┼───────────┐
        ↓           ↓           ↓
       KMZ       GeoJSON       CSV
```

Dengan pendekatan ini, aplikasi dapat berkembang dari tool internal menjadi platform yang mampu menangani banyak project, banyak user, design versioning, asynchronous generation, spatial data, dan workflow engineering yang lebih terkontrol.
