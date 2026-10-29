# Geospatial Frontend

React + Vite map workspace for imported KML/KMZ data, drawn features, point tiles, and role-based workflows.

## Stack

- React 19
- Vite
- deck.gl
- TanStack Query
- Better Auth client
- Tailwind CSS
- lucide-react icons

## Local Development

From the repository root:

```bash
docker compose up -d
```

The frontend is served at:

```text
http://localhost:5173
```

For direct local work inside this folder:

```bash
npm install
npm run dev
```

## Environment

```env
VITE_API_BASE_URL=http://localhost:3000
VITE_FTTH_URL=http://localhost:3001
VITE_GOOGLE_MAPS_API_KEY=
```

After login, the app selector opens FWA in the Geospatial workspace or FTTH
under `/ftth`. The FTTH Next.js app is reverse-proxied by Caddy on the same
domain. Its source and compose stack live in `../ftth/`.

`VITE_GOOGLE_MAPS_API_KEY` is only needed for the admin-only Street View panel.
It is a browser-exposed Vite value, so production Docker images receive it at build time from the GitHub Actions secret `VITE_GOOGLE_MAPS_API_KEY`. Restrict the Google Maps key by allowed HTTP referrers/domains in Google Cloud.

Production frontend compose uses runtime proxy envs:

```env
BACKEND_ORIGIN=http://<backend-host>:3000
FRONTEND_DOMAIN=geospatial.starliteindonesia.com
FRONTEND_PORT=80
FRONTEND_HTTPS_PORT=443
```

## Commands

```bash
npm run dev
npm run build
npm run lint
npm run preview
```

## Roles

- Admin route: `/admin/map`
- Staff route: `/staff/map`
- Admin-only UI: map upload/history, user management, Street View person control

Staff users can inspect maps and drawn data but do not see the Street View person control.
