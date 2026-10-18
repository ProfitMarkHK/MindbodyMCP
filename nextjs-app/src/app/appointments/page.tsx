'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAppointments, useSiteTimeZone, useStaff } from '@/hooks/useMindbody';
import { formatSiteDateTimeLong } from '@/lib/mindbody/formatSiteTime';
import type { Appointment } from '@/lib/mindbody/types';

// ============================================================================
// APPOINTMENTS PAGE - Appointment Schedule
// ============================================================================

export default function AppointmentsPage() {
  const [selectedStaff, setSelectedStaff] = useState<number | undefined>();

  const { data: staff } = useStaff();

  // Timestamps are the STUDIO's, not the viewer's. Resolved once here and passed
  // down so every card renders the same zone.
  const timeZone = useSiteTimeZone();

  // "All Staff" means every staff member the site returns. useAppointments
  // requires staffIds and disables the query while that list is empty.
  const staffIds = selectedStaff
    ? [selectedStaff]
    : (staff?.items.map((member) => member.id) ?? []);

  const { data: appointments, isLoading } = useAppointments({
    staffIds,
    locationIds: undefined,
  });

  const staffResolved = staff !== undefined;
  const showLoading = !staffResolved || (staffIds.length > 0 && isLoading);

  return (
    <main className="min-h-screen p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8">
          <Link
            href="/"
            className="text-sm text-muted-foreground hover:text-foreground mb-2 inline-block"
          >
            &larr; Back to Dashboard
          </Link>
          <h1 className="text-3xl font-bold">Appointments</h1>
          <p className="text-muted-foreground">
            View booked appointments by staff member, session, and time
          </p>
        </header>

        {/* Filters */}
        <div className="flex gap-4 mb-6">
          <select
            value={selectedStaff ?? ''}
            onChange={(e) =>
              setSelectedStaff(e.target.value ? Number(e.target.value) : undefined)
            }
            className="px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">All Staff</option>
            {staff?.items.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </div>

        {/* Appointments Grid */}
        {showLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="bg-card border rounded-lg p-6 animate-pulse">
                <div className="h-6 bg-muted rounded mb-4" />
                <div className="h-4 bg-muted rounded w-2/3 mb-2" />
                <div className="h-4 bg-muted rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : appointments && appointments.items.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {appointments.items.map((appointment) => (
              <AppointmentCard
                key={appointment.id}
                appointment={appointment}
                timeZone={timeZone}
              />
            ))}
          </div>
        ) : (
          <div className="text-center py-12 text-muted-foreground">
            No appointments found for the selected filters
          </div>
        )}

        {/* Total Count */}
        {appointments?.total ? (
          <p className="mt-6 text-sm text-muted-foreground">
            Showing {appointments.items.length} of {appointments.total} appointments
          </p>
        ) : null}
      </div>
    </main>
  );
}

function AppointmentCard({
  appointment,
  timeZone,
}: {
  appointment: Appointment;
  timeZone: string | undefined;
}) {
  // Mindbody's StartDateTime/EndDateTime are site-local with no offset, so these
  // are the studio's own wall clocks. `withZone` labels them so a viewer
  // elsewhere can see the clock is not their own.
  const startTime = formatSiteDateTimeLong(appointment.startDateTime, timeZone, {
    withZone: true,
    fallback: '—',
  });
  const endTime = formatSiteDateTimeLong(appointment.endDateTime, timeZone, {
    withZone: true,
    fallback: '—',
  });

  return (
    <div className="bg-card border rounded-lg p-6">
      <div className="flex justify-between items-start mb-4">
        <h3 className="font-semibold text-lg">{appointment.sessionTypeName}</h3>
        <span className="px-2 py-1 bg-muted text-muted-foreground text-xs rounded">
          {appointment.status}
        </span>
      </div>

      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          <span className="font-medium">Client:</span>{' '}
          {appointment.clientName || 'Unassigned'}
        </p>
        <p className="text-muted-foreground">
          <span className="font-medium">Staff:</span> {appointment.staffName}
        </p>
        <p className="text-muted-foreground">
          <span className="font-medium">Location:</span> {appointment.locationName}
        </p>
        <p className="text-muted-foreground">
          <span className="font-medium">Starts:</span> {startTime}
        </p>
        <p className="text-muted-foreground">
          <span className="font-medium">Ends:</span> {endTime}
        </p>
      </div>
    </div>
  );
}