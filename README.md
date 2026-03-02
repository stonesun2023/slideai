# S-slideai

AI-powered slide generation application built with Cloudflare Workers.

## Features

- Generate slides using AI
- User quota management
- Progressive Web App (PWA)
- Service Worker for offline functionality

## Project Structure

```
S-slideai/
├── public/
│   ├── index.html          # Main HTML file
│   ├── manifest.json       # PWA manifest
│   └── sw.js              # Service Worker
├── functions/
│   └── api/
│       ├── generate.js     # Slide generation endpoint
│       └── quota.js        # Quota management endpoint
├── wrangler.toml          # Cloudflare Workers configuration
└── README.md              # This file
```

## Development

1. Install dependencies
2. Run development server
3. Deploy to Cloudflare

## API Endpoints

- `POST /api/generate` - Generate slides
- `GET /api/quota?userId=xxx` - Check user quota

## License

MIT