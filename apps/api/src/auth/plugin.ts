// Auth plugin & guards.
// `authPlugin` mounts JWT and resolves the current user (or null) for EVERY
// request via a global derive — so any handler can read `user`. The guards
// `requireAuth` / `requireAdmin` add a scoped beforeHandle that 401/403s, applied
// only to the route groups that `.use` them.

import { jwt } from '@elysiajs/jwt';
import { Elysia } from 'elysia';
import { config } from '../config.ts';
import { type UserRow, userRepo } from '../db/repos.ts';

export const authPlugin = new Elysia({ name: 'auth' })
  .use(jwt({ name: 'jwt', secret: config.jwtSecret, exp: '7d' }))
  .derive({ as: 'global' }, async ({ jwt, headers }) => {
    const header = headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return { user: null as UserRow | null };
    const payload = await jwt.verify(token);
    const sub = payload && typeof payload === 'object' ? (payload as { sub?: unknown }).sub : null;
    if (typeof sub !== 'string') return { user: null as UserRow | null };
    const user = await userRepo.byId(sub);
    return { user: (user ?? null) as UserRow | null };
  });

export const requireAuth = new Elysia({ name: 'requireAuth' })
  .use(authPlugin)
  .onBeforeHandle({ as: 'scoped' }, ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Unauthorized' };
    }
  });

export const requireAdmin = new Elysia({ name: 'requireAdmin' })
  .use(authPlugin)
  .onBeforeHandle({ as: 'scoped' }, ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Unauthorized' };
    }
    if (user.role !== 'admin') {
      set.status = 403;
      return { error: 'Forbidden' };
    }
  });
