// Корневое приложение: REST API (/api/*), OAuth и токены, MCP (/api/mcp) и метаданные OAuth (/.well-known/*).
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { app } from './app.js';
import { mountMcp } from './mcp.js';
import { authServerMetadata, oauth, protectedResourceMetadata } from './oauth.js';

app.route('/', oauth); // /api/oauth/*, /api/tokens — с общими CORS и обработкой ошибок

export const root = new Hono();
root.use('/.well-known/*', cors({ origin: '*' }));
root.use('/api/mcp', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Session-Id', 'Mcp-Protocol-Version'], exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'] }));
root.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata(c)));
root.get('/.well-known/oauth-protected-resource/*', (c) => c.json(protectedResourceMetadata(c)));
root.get('/.well-known/oauth-authorization-server', (c) => c.json(authServerMetadata(c)));
root.get('/.well-known/oauth-authorization-server/*', (c) => c.json(authServerMetadata(c)));
mountMcp(root, app);
root.route('/', app);
