# FTTH Planner

The FTTH planner source is included here from the FTTH Design Generator
repository. It runs at `/ftth` behind the Geospatial frontend reverse proxy.

## Local startup

1. Copy `.env.example` to `.env` and replace the database and service secrets.
2. Start the planner services from this directory:

   ```sh
   docker compose up --build -d
   ```

3. Start the Geospatial frontend locally from `../frontend` with
   `npm run dev`; it proxies `/ftth/*` to the planner on port `3301`.
4. Open `http://localhost:5173`, sign in, then choose **FTTH**.

The Geospatial frontend's Vite proxy forwards `/ftth/*` to the local planner
service at `http://localhost:3301`.

## Production routing

The FTTH web service joins the `geospatial-ftth-gateway` network. Start this
stack before the Geospatial production frontend so the network exists. Set
`FTTH_APP_URL=https://geospatial.starliteindonesia.com/ftth` and configure the
Geospatial frontend's `FTTH_ORIGIN=http://ftth-web:3000`. Caddy forwards `/ftth`
to that service; the FTTH Next.js build uses `/ftth` as its base path.

FTTH currently retains its own authentication database and login. The unified
URL and application selector do not yet provide single sign-on.
