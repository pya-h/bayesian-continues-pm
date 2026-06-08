import { loginSchema, registerSchema } from '@bmm/shared';
import { Elysia } from 'elysia';
import { authPlugin } from '../auth/plugin.ts';
import { userRepo } from '../db/repos.ts';
import { publicUser } from '../lib/user.ts';

export const authRoutes = new Elysia({ prefix: '/auth' })
  .use(authPlugin)
  .post('/register', async ({ body, jwt, set }) => {
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: 'Validation failed', issues: parsed.error.issues };
    }
    const { username, password } = parsed.data;
    if (await userRepo.byUsername(username)) {
      set.status = 409;
      return { error: 'Username already taken' };
    }
    const passwordHash = await Bun.password.hash(password);
    const user = await userRepo.create({ username, passwordHash, balance: 0 });
    const token = await jwt.sign({ sub: user.userId, role: user.role });
    set.status = 201;
    return { token, user: publicUser(user) };
  })
  .post('/login', async ({ body, jwt, set }) => {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      return { error: 'Validation failed', issues: parsed.error.issues };
    }
    const { username, password } = parsed.data;
    const user = await userRepo.byUsername(username);
    if (!user || !(await Bun.password.verify(password, user.passwordHash))) {
      set.status = 401;
      return { error: 'Invalid credentials' };
    }
    const token = await jwt.sign({ sub: user.userId, role: user.role });
    return { token, user: publicUser(user) };
  })
  .get('/me', ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Unauthorized' };
    }
    return { user: publicUser(user) };
  });
