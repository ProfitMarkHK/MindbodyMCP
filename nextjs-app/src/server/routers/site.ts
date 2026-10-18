import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';

// ============================================================================
// SITE & LOCATION ROUTER
// ============================================================================

export const siteRouter = router({
  getSites: protectedProcedure.query(async ({ ctx }) => {
    return ctx.mindbody.getSites();
  }),

  /**
   * The studio's IANA timezone, so the pages can render every timestamp in the
   * studio's own zone instead of the viewer's browser zone. The site record is
   * cached for an hour server-side, so this is one lookup per process at worst.
   *
   * Deliberately NOT `getSites().items[0].timeZone`: with a multi-site API key
   * that would silently label one studio's schedule with another's zone.
   */
  getTimeZone: protectedProcedure.query(async ({ ctx }) => {
    return ctx.mindbody.getSiteTimeZone();
  }),

  getLocations: protectedProcedure.query(async ({ ctx }) => {
    return ctx.mindbody.getLocations();
  }),

  getResources: protectedProcedure.query(async ({ ctx }) => {
    return ctx.mindbody.getResources();
  }),

  getActivationCode: protectedProcedure.query(async ({ ctx }) => {
    return ctx.mindbody.getActivationCode();
  }),

  getPrograms: protectedProcedure
    .input(
      z
        .object({
          scheduleType: z.enum(['All', 'Class', 'Enrollment', 'Appointment']).optional(),
          onlineOnly: z.boolean().optional(),
          limit: z.number().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return ctx.mindbody.getPrograms(input);
    }),

  getSessionTypes: protectedProcedure
    .input(
      z
        .object({
          programIds: z.array(z.number()).optional(),
          onlineOnly: z.boolean().optional(),
          limit: z.number().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return ctx.mindbody.getSessionTypes(input);
    }),
});
