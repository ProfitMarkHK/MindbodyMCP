'use client';

import Link from 'next/link';
import { useSites } from '@/hooks/useMindbody';
import type { Site } from '@/lib/mindbody/types';

// ============================================================================
// SITES PAGE - Site Directory
// ============================================================================

export default function SitesPage() {
  const { data: sites, isLoading } = useSites();

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
          <h1 className="text-3xl font-bold">Sites</h1>
          <p className="text-muted-foreground">
            Business locations served by this Mindbody account
          </p>
        </header>

        {/* Sites Grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-card border rounded-lg p-6 animate-pulse">
                <div className="h-6 bg-muted rounded mb-4" />
                <div className="h-4 bg-muted rounded w-2/3 mb-2" />
                <div className="h-4 bg-muted rounded w-1/2" />
              </div>
            ))}
          </div>
        ) : sites?.items && sites.items.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sites.items.map((site) => (
              <SiteCard key={site.id} site={site} />
            ))}
          </div>
        ) : (
          <div className="text-center py-12 text-muted-foreground">
            No sites found
          </div>
        )}

        {/* Total Count */}
        {sites?.total && (
          <p className="mt-6 text-sm text-muted-foreground">
            Showing {sites.items.length} of {sites.total} sites
          </p>
        )}
      </div>
    </main>
  );
}

function SiteCard({ site }: { site: Site }) {
  return (
    <div className="bg-card border rounded-lg p-6">
      <h3 className="font-semibold text-lg mb-2">{site.name}</h3>

      <div className="space-y-2 text-sm">
        {site.description && (
          <p className="text-muted-foreground">{site.description}</p>
        )}
        {site.contactEmail && (
          <p className="text-muted-foreground">
            <span className="font-medium">Email:</span> {site.contactEmail}
          </p>
        )}
        {site.timeZone && (
          <p className="text-muted-foreground">
            <span className="font-medium">Timezone:</span> {site.timeZone}
          </p>
        )}
      </div>
    </div>
  );
}