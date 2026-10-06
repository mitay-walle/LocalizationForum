// Локальная разработка: API + сайт на одном порту.  npm run dev → http://localhost:3000
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { root as api } from '../src/server.js';

try {
  process.loadEnvFile('.env');
} catch {
  // .env необязателен
}

const root = new Hono();
root.route('/', api);
root.use('/*', serveStatic({ root: './site' }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: root.fetch, port }, () => console.log(`http://localhost:${port}`));
