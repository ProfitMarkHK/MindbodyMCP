import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';

// ============================================================================
// ENROLLMENT ROUTER
// ============================================================================

export const enrollmentRouter = router({
  getAll: protectedProcedure
    .input(
      z
        .object({
          locationIds: z.array(z.number()).optional(),
          classScheduleIds: z.array(z.number()).optional(),
          staffIds: z.array(z.number()).optional(),
          programIds: z.array(z.number()).optional(),
          sessionTypeIds: z.array(z.number()).optional(),
          startDate: z.string().optional(),
          endDate: z.string().optional(),
          limit: z.number().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return ctx.mindbody.getEnrollments(input);
    }),

  addClient: protectedProcedure
    .input(
      z.object({
        clientId: z.string(),
        classScheduleId: z.number().int().positive(),
        /** EnrollDateForward: book every session from this date-time on. */
        enrollDateForward: z.string().optional(),
        /** EnrollOpen: book only these session date-times. */
        enrollOpenDates: z.array(z.string()).optional(),
        waitlist: z.boolean().optional(),
        waitlistEntryId: z.number().int().optional(),
        sendEmail: z.boolean().optional(),
        test: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.mindbody.addClientToEnrollment(input);
    }),

  getClientEnrollments: protectedProcedure
    .input(
      z.object({
        clientId: z.string(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      return ctx.mindbody.getClientEnrollments(input.clientId, input.startDate, input.endDate);
    }),
});
