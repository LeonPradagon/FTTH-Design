# Geospatial Backend

NestJS API for the geospatial workspace.

## Stack

- NestJS
- Better Auth cookie sessions
- Drizzle ORM
- PostgreSQL + PostGIS
- GraphHopper route preview/import routing
- Swagger at `/docs`

## Local Development

From the repository root, prefer Docker Compose:

```bash
docker compose up -d
```

The backend runs in watch mode inside the `backend` service:

```bash
docker compose logs -f backend
```

For direct local work inside this folder:

```bash
npm install
npm run start:dev
```

## Environment

Important backend variables:

```env
PORT=3000
BETTER_AUTH_SECRET=change_me_generate_a_strong_secret
BETTER_AUTH_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:5173
DATABASE_URL=postgres://postgres:postgres@db:5432/geospatial_app
DATABASE_POOL_MAX=10
SESSION_TTL_HOURS=168
GRAPHHOPPER_URL=http://graphhopper:8989
GRAPHHOPPER_TIMEOUT_MS=15000
GRAPHHOPPER_PROFILE=motor_scooter
```

Production compose requires `DATABASE_URL` and `BETTER_AUTH_SECRET`.

## Commands

```bash
npm run build
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run db:migrate
npm run maps:import-kmz -- <path-to-.kmz-or-.kml-or-folder> [map name]
npm run regions:import-provinces
```

## Routing

Imported KML/KMZ line geometries use Auto Routing through GraphHopper by default. Browser KML uploads can turn Auto Routing off to keep source-defined Route Segment geometry. Drawn line features route through GraphHopper using the `motor_scooter` profile. The backend first tries a strict no-toll/no-motorway custom model and falls back to a relaxed route when needed.

When routing succeeds, the original KML geometry is preserved in `rawProperties.originalGeometry`, while the stored PostGIS geometry becomes the routed line. KML styling is kept; routed lines are not forced to a route-specific color.

When routing fails, import continues and stores the original geometry with `routeStatus=failed`.

## Access Rules

- Admin can upload/import maps and manage users.
- Staff can inspect maps but cannot import maps.
- Street View UI is admin-only on the frontend.
