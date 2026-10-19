'use client';

import Link from 'next/link';
import { useLocations } from '@/hooks/useMindbody';
import type { Location } from '@/lib/mindbody/types';

// ============================================================================
// LOCATIONS PAGE - Studio Location Directory
// ============================================================================

export default function LocationsPage() {
  const { data: locations, isLoading } = useLocations();

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
          <h1 className="text-3xl font-bold">Locations</h1>
          <p className="text-muted-foreground">
            Studios within the site, with addresses and contact details
          </p>
        </header>

        {/* Locations Grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="bg-card border rounded-lg p-6 animate-pulse">
                <div className="h-6 bg-muted rounded mb-4" />
                <div className="h-4 bg-muted rounded w-2/3 mb-2" />
                <div className="h-4 bg-muted rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : locations?.items && locations.items.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {locations.items.map((location) => (
              <LocationCard key={location.id} location={location} />
            ))}
          </div>
        ) : (
          <div className="text-center py-12 text-muted-foreground">
            No locations found
          </div>
        )}

        {/* Total Count */}
        {locations?.total && (
          <p className="mt-6 text-sm text-muted-foreground">
            Showing {locations.items.length} of {locations.total} locations
          </p>
        )}
      </div>
    </main>
  );
}

function LocationCard({ location }: { location: Location }) {
  // Compose one address line from the fields Location actually defines. A
  // missing city or state renders as an em dash rather than "undefined".
  const street = [location.address, location.address2].filter(Boolean).join(' ');
  const cityLine = `${location.city ?? '—'}, ${location.state ?? '—'}`;
  const region = [location.postalCode, location.country].filter(Boolean).join(', ');
  const addressLine = [street, cityLine, region].filter(Boolean).join(', ');

  return (
    <div className="bg-card border rounded-lg p-6">
      <h3 className="font-semibold text-lg mb-2">{location.name}</h3>

      <div className="space-y-2 text-sm">
        {location.description && (
          <p className="text-muted-foreground">{location.description}</p>
        )}
        <p className="text-muted-foreground">
          <span className="font-medium">Address:</span> {addressLine}
        </p>
      </div>
    </div>
  );
}