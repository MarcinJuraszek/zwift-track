# Zwift Route Tracker

Track your Zwift route completion progress. View all available cycling routes and see which ones you've completed via Strava integration.

## Setup

```bash
nvm use          # Use Node 22
npm install      # Install dependencies
```

### Strava Integration

1. Create a Strava API app at https://www.strava.com/settings/api
2. Set "Authorization Callback Domain" to `localhost`
3. Copy `.env.local.example` to `.env.local` and add your credentials
4. Run `npm run strava:auth` to authorize (opens browser)
5. Run `npm run sync:activities` to fetch your rides

## Scripts

```bash
npm run sync:routes       # Pull latest route data from zwift-data package
npm run strava:auth       # One-time Strava OAuth setup
npm run sync:activities   # Fetch recent Zwift rides from Strava
npm run dev               # Start dev server
npm run build             # Build static site
npm run preview           # Preview built site
```

## Architecture

- **Route data**: Pulled from the [`zwift-data`](https://github.com/andipaetzold/zwift-data) npm package via a local sync script, stored as JSON in `src/data/routes.json`
- **Activity data**: Fetched from the Strava API (VirtualRide activities only), matched to routes by name, stored in `src/data/completed-routes.json`
- **Site**: Built with [Astro](https://astro.build/) as a fully static site
- **Hosting**: GitHub Pages
