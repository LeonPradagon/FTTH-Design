# geospatial

Geospatial map workspace for KML/KMZ imports, province navigation, point tiles, drawn features, and GraphHopper-backed auto-routing.

## Services

- `frontend`: React + Vite + deck.gl
- `backend`: NestJS + Better Auth + Drizzle
- `db`: PostgreSQL + PostGIS for local development
- `graphhopper`: self-hosted route engine for imported/drawn line routing
- `ftth/`: FTTH planner (Next.js frontend + NestJS API) served at `/ftth`

## Local Setup

Copy the example env when needed:

```bash
cp .env.example .env
```

Start the full local stack:

```bash
docker compose up -d --build
```

The FTTH planner source is included in `ftth/` and is served at `/ftth` behind
the frontend proxy. Start its services with `cd ftth && cp .env.example .env
&& docker compose up --build -d`, then return to this folder and start the
Geospatial frontend. For the containerized Geospatial frontend, use
`docker compose -f compose.yaml -f compose-ftth.yaml up -d --build` so its
`/ftth` proxy can reach the planner on the shared Docker network.

Local URLs:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3000`
- Backend health: `http://localhost:3000/health`
- Backend docs: `http://localhost:3000/docs` in development only
- PostgreSQL/PostGIS: `localhost:5432`
- GraphHopper: `http://localhost:8989`

Migrations run automatically before the backend starts. Frontend and backend source folders are mounted into containers and run in watch mode.

## Environment

Required for production backend:

```env
DATABASE_URL=postgres://...
BETTER_AUTH_SECRET=change_me_generate_a_strong_secret
```

Common production backend values:

```env
BETTER_AUTH_URL=https://geospatial.starliteindonesia.com
CORS_ORIGIN=https://geospatial.starliteindonesia.com,http://<backend-ip>
GRAPHHOPPER_JAVA_OPTS=-Xmx6g
```

GraphHopper variables are optional because compose defines defaults:

```env
GRAPHHOPPER_URL=http://graphhopper:8989
GRAPHHOPPER_TIMEOUT_MS=15000
GRAPHHOPPER_PROFILE=motor_scooter
GRAPHHOPPER_OSM_URL=https://download.geofabrik.de/asia/indonesia-latest.osm.pbf
GRAPHHOPPER_FORCE_REBUILD=false
GRAPHHOPPER_JAVA_OPTS=-Xmx6g
```

For a backend-only 4 vCPU / 8 GiB server, use `GRAPHHOPPER_JAVA_OPTS=-Xmx6g`. For 4 vCPU / 16 GiB, use `-Xmx10g`.

## GraphHopper Routing

Imported KML/KMZ LineString and MultiLineString features use Auto Routing through GraphHopper during import by default. Browser KML uploads can turn Auto Routing off to keep source-defined Route Segment geometry. Drawn line features also route through GraphHopper when saved.

Routing behavior:

- profile: `motor_scooter`
- first attempt: avoid toll roads and motorways
- fallback: relaxed route when the strict route cannot be found
- original KML geometry is preserved in `rawProperties.originalGeometry`
- KML line color/style is preserved; routed lines are not forced blue
- if routing fails, import keeps the original geometry and marks `routeStatus=failed`

GraphHopper data is stored under:

```text
.data/graphhopper
```

The Indonesia PBF and generated graph cache are not committed. On a new server, GraphHopper downloads the PBF and builds `.data/graphhopper/graph-cache` on first startup. This can take a long time and needs enough disk/RAM.

## Data Imports

Place local source files under `.data/` when importing manually. `.data` is intentionally not pushed to GitHub.

Import a KML/KMZ/folder:

```bash
docker compose exec backend npm run maps:import-kmz -- ".data/source.kmz" "Map name"
```

Province boundaries are bundled at:

```text
backend/src/regions/data/indonesia-38-provinces.geojson
```

They are seeded automatically when the `provinces` table is empty. To import explicitly:

```bash
docker compose exec backend npm run regions:import-provinces
```

## Accounts And Roles

Local bootstrap accounts:

- admin: `admin@example.com` / `example123`
- staff: `designer@example.com` / `example123`

Routes:

- admin: `/admin/map`
- staff: `/staff/map`

Admin-only UI:

- map upload and upload history
- user management
- Street View person control

Do not keep local default credentials in production.

## Production Compose

Backend deploy compose:

```bash
docker compose --env-file .env.production -f compose-prod.backend.yaml up -d
```

Frontend deploy compose:

```bash
docker compose --env-file .env.production -f compose-prod.frontend.yaml up -d
```

Production backend compose includes GraphHopper and waits for its `/health` endpoint before starting the backend. GraphHopper port `8989` is bound to `127.0.0.1` only in prod compose.

Frontend production compose uses:

```env
BACKEND_ORIGIN=http://<backend-host>:3000
FRONTEND_DOMAIN=geospatial.starliteindonesia.com
```

The frontend compose persists Caddy state in named volumes so TLS certificates survive container replacement:

```text
caddy_data
caddy_config
```

`VITE_GOOGLE_MAPS_API_KEY` is baked into the static frontend bundle at image build time by GitHub Actions. Set it as a GitHub Actions secret named `VITE_GOOGLE_MAPS_API_KEY`; do not rely on `.env.production` on the frontend server for this value. Because it is exposed to browsers, restrict the Google Maps key by allowed HTTP referrers/domains in Google Cloud.

## Useful Commands

```bash
docker compose ps
docker compose logs -f --tail=200 frontend
docker compose logs -f --tail=200 backend
docker compose logs -f --tail=200 graphhopper
docker compose restart frontend
docker compose restart backend
docker compose down
```

Reset local volumes, including Postgres:

```bash
docker compose down -v
```

## Rebuild Rules

No rebuild usually needed for changes under:

- `frontend/src`
- `backend/src`

Rebuild when changing dependencies, Dockerfiles, compose files, or routing image files:

```bash
docker compose up -d --build --force-recreate --renew-anon-volumes frontend backend graphhopper
```

## Tests

Backend:

```bash
cd backend
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
```

Frontend:

```bash
cd frontend
npm run build
```
