import { Hono } from 'hono';
import { html } from 'hono/html';
import { api, isApiPath } from './api/index.ts';
import { dashboard } from './dashboard/index.ts';
import { layout } from './dashboard/layout.ts';
import { ApiError } from './errors.ts';
import { publicRoutes } from './public.ts';

export const app = new Hono();

app.get('/', (c) => c.redirect('/dashboard'));
app.route('/', publicRoutes);
app.route('/dashboard', dashboard);
app.route('/', api);

app.notFound((c) => {
  if (isApiPath(c.req.path)) return c.json(new ApiError(404, 'not_found', 'The requested endpoint does not exist.').toJSON(), 404);
  return c.text('Not found', 404);
});

app.onError((err, c) => {
  const apiError =
    err instanceof ApiError ? err : new ApiError(500, 'application_error', 'An unexpected error occurred. Check the server logs.');
  if (!(err instanceof ApiError)) console.error('[http]', c.req.method, c.req.path, err);
  if (c.req.path.startsWith('/dashboard')) {
    return c.html(
      layout({ title: 'Error', path: c.req.path, body: html`<h1>${apiError.statusCode === 404 ? 'Not found' : 'Something went wrong'}</h1><p class="sub">${apiError.message}</p>` }),
      apiError.statusCode,
    );
  }
  return c.json(apiError.toJSON(), apiError.statusCode);
});
