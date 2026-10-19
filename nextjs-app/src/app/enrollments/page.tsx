'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useEnrollments, useLocations, useSiteTimeZone } from '@/hooks/useMindbody';
import { formatSiteDate } from '@/lib/mindbody/formatSiteTime';
import type { Enrollment } from '@/lib/mindbody/types';

// ============================================================================
// ENROLLMENTS PAGE - Course and Workshop Enrollment Schedules
// ============================================================================

export default function EnrollmentsPage() {
  const [selectedLocation, setSelectedLocation] = useState<number | undefined>();
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const { data: locations } = useLocations();
  // Enrollment start/end dates are the studio's calendar dates, not the viewer's.
  const timeZone = useSiteTimeZone();
  const { data: enrollments, isLoading } = useEnrollments({
    locationIds: selectedLocation ? [selectedLocation] : undefined,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
  });

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
          <h1 className="text-3xl font-bold">Enrollments</h1>
          <p className="text-muted-foreground">
            Browse course and workshop enrollment schedules across the studio
          </p>
        </header>

        {/* Filters */}
        <div className="flex flex-wrap gap-4 mb-6">
          <select
            value={selectedLocation ?? ''}
            onChange={(e) =>
              setSelectedLocation(e.target.value ? Number(e.target.value) : undefined)
            }
            className="px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">All Locations</option>
            {locations?.items.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>

          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            aria-label="Start date"
            className="px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
          />

          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            aria-label="End date"
            className="px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        {/* Enrollments Table */}
        {isLoading ? (
          <div className="bg-card border rounded-lg overflow-hidden">
            <div className="bg-muted p-4">
              <div className="h-5 bg-card rounded w-1/4" />
            </div>
            {[...Array(6)].map((_, i) => (
              <div key={i} className="border-t p-4 animate-pulse">
                <div className="h-4 bg-muted rounded w-1/3 mb-2" />
                <div className="h-4 bg-muted rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : enrollments?.items && enrollments.items.length > 0 ? (
          <div className="bg-card border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="text-left p-4 font-medium">Enrollment</th>
                  <th className="text-left p-4 font-medium">Program</th>
                  <th className="text-left p-4 font-medium">Session Type</th>
                  <th className="text-left p-4 font-medium">Staff</th>
                  <th className="text-left p-4 font-medium">Location</th>
                  <th className="text-left p-4 font-medium">Days</th>
                  <th className="text-left p-4 font-medium">Dates</th>
                  <th className="text-left p-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {enrollments.items.map((enrollment) => (
                  <EnrollmentRow
                    key={enrollment.id}
                    enrollment={enrollment}
                    timeZone={timeZone}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-12 text-muted-foreground">
            No enrollments found for the selected filters
          </div>
        )}

        {/* Total Count */}
        {enrollments?.total && (
          <p className="mt-6 text-sm text-muted-foreground">
            Showing {enrollments.items.length} of {enrollments.total} enrollments
          </p>
        )}
      </div>
    </main>
  );
}

/**
 * Replaced by `formatSiteDate` from @/lib/mindbody/formatSiteTime, with the
 * reasoning kept here because this page had its own local formatter. The old one
 * ran `new Date(value).toLocaleDateString(...)`, i.e. in the VIEWER's zone; a
 * bare Mindbody date such as "2026-01-15" is parsed as UTC midnight, so every
 * viewer west of UTC saw the day before. Rendering the studio's own calendar
 * fields removes the viewer's zone from the result entirely.
 */

function EnrollmentRow({
  enrollment,
  timeZone,
}: {
  enrollment: Enrollment;
  timeZone: string | undefined;
}) {
  return (
    <tr className="border-t">
      <td className="p-4">
        <p className="font-medium">{enrollment.name}</p>
      </td>
      <td className="p-4 text-muted-foreground">
        {enrollment.programName ?? '—'}
      </td>
      <td className="p-4 text-muted-foreground">
        {enrollment.sessionTypeName ?? '—'}
      </td>
      <td className="p-4 text-muted-foreground">{enrollment.staffName}</td>
      <td className="p-4 text-muted-foreground">{enrollment.locationName}</td>
      <td className="p-4 text-muted-foreground">
        {enrollment.days.length > 0 ? enrollment.days.join(', ') : '—'}
      </td>
      <td className="p-4 text-muted-foreground">
        {formatSiteDate(enrollment.startDate, timeZone, { fallback: '—' })} -{' '}
        {formatSiteDate(enrollment.endDate, timeZone, { fallback: '—' })}
      </td>
      <td className="p-4">
        <span
          className={`px-2 py-1 text-xs rounded ${
            enrollment.isAvailable
              ? 'bg-green-100 text-green-800'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {enrollment.isAvailable ? 'Open' : 'Closed'}
        </span>
      </td>
    </tr>
  );
}
