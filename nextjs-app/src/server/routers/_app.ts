import { router } from '../trpc';
import { siteRouter } from './site';
import { staffRouter } from './staff';
import { clientRouter } from './client';
import { classRouter } from './class';
import { appointmentRouter } from './appointment';
import { enrollmentRouter } from './enrollment';
import { salesRouter } from './sales';

// ============================================================================
// MAIN APP ROUTER - Combines all sub-routers
// ============================================================================

export const appRouter = router({
  site: siteRouter,
  staff: staffRouter,
  // `client` is reserved by the tRPC React proxy (it collides with a built-in
  // method and fails to type-check), so the client router is mounted as `clients`.
  clients: clientRouter,
  class: classRouter,
  appointment: appointmentRouter,
  enrollment: enrollmentRouter,
  sales: salesRouter,
});

export type AppRouter = typeof appRouter;
