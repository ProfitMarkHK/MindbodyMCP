'use client';

import Link from 'next/link';
import { useContracts, usePackages, useProducts, useServices } from '@/hooks/useMindbody';
import type { Package } from '@/lib/mindbody/types';

// ============================================================================
// SALES PAGE - Services, Packages, Products, Contracts
// ============================================================================

export default function SalesPage() {
  const { data: services, isLoading: loadingServices } = useServices();
  const { data: packages, isLoading: loadingPackages } = usePackages();
  const { data: products, isLoading: loadingProducts } = useProducts();
  const { data: contracts, isLoading: loadingContracts } = useContracts();

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
          <h1 className="text-3xl font-bold">Sales</h1>
          <p className="text-muted-foreground">
            Browse the services, packages, products, and contracts sold at this site
          </p>
        </header>

        <div className="space-y-12">
          <section>
            <h2 className="text-2xl font-semibold mb-4">Services</h2>
            <div className="bg-card border rounded-lg overflow-hidden">
              {loadingServices ? (
                <div className="p-8 text-center">
                  <div className="animate-pulse">Loading services...</div>
                </div>
              ) : services && services.items.length > 0 ? (
                <table className="w-full">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left p-4 font-medium">Name</th>
                      <th className="text-left p-4 font-medium">Price</th>
                      <th className="text-left p-4 font-medium">Online Price</th>
                      <th className="text-left p-4 font-medium">Count</th>
                      <th className="text-left p-4 font-medium">Tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {services.items.map((service) => (
                      <tr key={service.id} className="border-t hover:bg-muted/50">
                        <td className="p-4 font-medium">{service.name}</td>
                        <td className="p-4">${service.price.toFixed(2)}</td>
                        <td className="p-4">
                          {service.onlinePrice !== undefined
                            ? `$${service.onlinePrice.toFixed(2)}`
                            : '-'}
                        </td>
                        <td className="p-4">{service.count ?? '-'}</td>
                        <td className="p-4">
                          {service.taxIncluded
                            ? 'Included'
                            : service.taxRate !== undefined
                            ? `${service.taxRate}%`
                            : 'Excluded'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="p-8 text-center text-muted-foreground">
                  No services available
                </div>
              )}
            </div>
            {services?.total ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Showing {services.items.length} of {services.total} services
              </p>
            ) : null}
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">Packages</h2>
            <div className="bg-card border rounded-lg overflow-hidden">
              {loadingPackages ? (
                <div className="p-8 text-center">
                  <div className="animate-pulse">Loading packages...</div>
                </div>
              ) : packages && packages.items.length > 0 ? (
                <table className="w-full">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left p-4 font-medium">Name</th>
                      <th className="text-left p-4 font-medium">Class Count</th>
                      <th className="text-left p-4 font-medium">Price</th>
                      <th className="text-left p-4 font-medium">Online Price</th>
                      <th className="text-left p-4 font-medium">Sold Online</th>
                    </tr>
                  </thead>
                  <tbody>
                    {packages.items.map((pkg) => (
                      <PackageRow key={pkg.id} item={pkg} />
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="p-8 text-center text-muted-foreground">
                  No packages available
                </div>
              )}
            </div>
            {packages?.total ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Showing {packages.items.length} of {packages.total} packages
              </p>
            ) : null}
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">Products</h2>
            <div className="bg-card border rounded-lg overflow-hidden">
              {loadingProducts ? (
                <div className="p-8 text-center">
                  <div className="animate-pulse">Loading products...</div>
                </div>
              ) : products && products.items.length > 0 ? (
                <table className="w-full">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left p-4 font-medium">Name</th>
                      <th className="text-left p-4 font-medium">Category</th>
                      <th className="text-left p-4 font-medium">Price</th>
                      <th className="text-left p-4 font-medium">Online Price</th>
                      <th className="text-left p-4 font-medium">Sold Online</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.items.map((product) => (
                      <tr key={product.id} className="border-t hover:bg-muted/50">
                        <td className="p-4">
                          <p className="font-medium">{product.name}</p>
                          {product.description && (
                            <p className="text-sm text-muted-foreground">
                              {product.description}
                            </p>
                          )}
                        </td>
                        <td className="p-4">{product.category || '-'}</td>
                        <td className="p-4">${product.price.toFixed(2)}</td>
                        <td className="p-4">
                          {product.onlinePrice !== undefined
                            ? `$${product.onlinePrice.toFixed(2)}`
                            : '-'}
                        </td>
                        <td className="p-4">{product.sellOnline ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="p-8 text-center text-muted-foreground">
                  No products available
                </div>
              )}
            </div>
            {products?.total ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Showing {products.items.length} of {products.total} products
              </p>
            ) : null}
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4">Contracts</h2>
            <div className="bg-card border rounded-lg overflow-hidden">
              {loadingContracts ? (
                <div className="p-8 text-center">
                  <div className="animate-pulse">Loading contracts...</div>
                </div>
              ) : contracts && contracts.items.length > 0 ? (
                <table className="w-full">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left p-4 font-medium">Name</th>
                      <th className="text-left p-4 font-medium">Type</th>
                      <th className="text-left p-4 font-medium">Assigns Membership</th>
                      <th className="text-left p-4 font-medium">Autopay</th>
                      <th className="text-left p-4 font-medium">Intro Offer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contracts.items.map((contract) => (
                      <tr key={contract.id} className="border-t hover:bg-muted/50">
                        <td className="p-4">
                          <p className="font-medium">{contract.name}</p>
                          {contract.description && (
                            <p className="text-sm text-muted-foreground">
                              {contract.description}
                            </p>
                          )}
                        </td>
                        <td className="p-4">{contract.contractType}</td>
                        <td className="p-4">
                          {contract.assignsMembershipName || '-'}
                        </td>
                        <td className="p-4">
                          {contract.autopaySchedule
                            ? `${contract.autopaySchedule.frequency} at $${contract.autopaySchedule.paymentAmount.toFixed(2)}`
                            : '-'}
                        </td>
                        <td className="p-4">
                          {contract.introOffer
                            ? `${contract.introOffer.name} ($${contract.introOffer.price.toFixed(2)})`
                            : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="p-8 text-center text-muted-foreground">
                  No contracts available
                </div>
              )}
            </div>
            {contracts?.total ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Showing {contracts.items.length} of {contracts.total} contracts
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}

function PackageRow({ item }: { item: Package }) {
  return (
    <tr className="border-t hover:bg-muted/50">
      <td className="p-4">
        <p className="font-medium">{item.name}</p>
        {item.services && item.services.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {item.services.map((service) => `${service.count} x ${service.name}`).join(', ')}
          </p>
        )}
      </td>
      <td className="p-4">{item.classCount}</td>
      <td className="p-4">${item.price.toFixed(2)}</td>
      <td className="p-4">
        {item.onlinePrice !== undefined ? `$${item.onlinePrice.toFixed(2)}` : '-'}
      </td>
      <td className="p-4">{item.sellOnline ? 'Yes' : 'No'}</td>
    </tr>
  );
}

