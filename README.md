# Zwift Route Tracker

Track your Zwift route completion progress. View all available routes and (coming soon) track which ones you've completed.

## Setup

```bash
nvm use          # Use Node 22
npm install      # Install dependencies
```

## Scripts

```bash
npm run sync:routes   # Pull latest route data from zwift-data package
npm run dev           # Start dev server
npm run build         # Build static site
npm run preview       # Preview built site
```

## Architecture

- **Route data**: Pulled from the [`zwift-data`](https://github.com/andipaetzold/zwift-data) npm package via a local sync script, stored as JSON in `src/data/routes.json`
- **Site**: Built with [Astro](https://astro.build/) as a fully static site
- **Hosting**: GitHub Pages
