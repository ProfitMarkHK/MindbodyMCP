import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';

/**
 * Get available services (pricing options: class packs, memberships).
 *
 * `GET /sale/services` (`Mindbody.PublicApi.Dto.Models.V6.Service`).
 *
 * Removed output fields (C-19, `docs/mindbody-spec-discrepancies.md`):
 * - `sessionTypeId` — `Service` has no per-row session type. Session-type
 *   applicability is the `sessionTypeIds` REQUEST filter; the sandbox confirms
 *   no `SessionTypeId` key on any of the 21 rows.
 * - `prerequisite` — `Service` has no prerequisite field anywhere in the spec or
 *   the sandbox.
 * Both used to render as `undefined` on every row.
 *
 * Two field TYPES were also wrong, and both produced garbage rather than nothing:
 * - `priority` is `"High" | "Medium" | "Low"` (a string) in the spec, so the old
 *   `Number(Priority)` yielded `NaN`. It is passed through as a string.
 * - `taxIncluded` is the AMOUNT of tax included in the price (a number), not a
 *   flag, so the old `Boolean(TaxIncluded)` turned any non-zero tax into `true`
 *   and any zero tax into `false`. It is now `taxIncludedAmount`, the number the
 *   API documents; it is `0` when the price has no tax baked in.
 */
export async function getServicesTool(
  programIds?: number[],
  sessionTypeIds?: number[],
  locationId?: number,
  classId?: number,
  hideRelatedPrograms: boolean = false,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  services: Array<{
    id: number;
    name: string;
    price: number;
    onlinePrice?: number;
    /** The tax amount already included in `price` (spec: "The amount of tax
     *  included in the price, if inclusive pricing is enabled"). */
    taxIncludedAmount?: number;
    taxRate?: number;
    programId?: number;
    count?: number;
    expirationUnit?: string;
    expirationLength?: number;
    membershipId?: number;
    /** "High" | "Medium" | "Low" — a string in the spec, not a number. */
    priority?: string;
  }>;
  totalServices: number;
}> {
  const { items: servicesRaw, totalResults } = await fetchAllPages<any>(
    client,
    '/sale/services',
    {
      ProgramIds: programIds,
      SessionTypeIds: sessionTypeIds,
      LocationId: locationId,
      ClassId: classId,
      HideRelatedPrograms: hideRelatedPrograms,
    },
    'Services'
  );

  const services = servicesRaw.map((service: any) => ({
    id: Number(service.Id ?? service.id),
    name: service.Name,
    price: Number(service.Price ?? 0),
    onlinePrice: service.OnlinePrice != null ? Number(service.OnlinePrice) : undefined,
    taxIncludedAmount: service.TaxIncluded != null ? Number(service.TaxIncluded) : undefined,
    taxRate: service.TaxRate != null ? Number(service.TaxRate) : undefined,
    programId: service.ProgramId != null ? Number(service.ProgramId) : undefined,
    count: service.Count != null ? Number(service.Count) : undefined,
    expirationUnit: service.ExpirationUnit,
    expirationLength: service.ExpirationLength != null ? Number(service.ExpirationLength) : undefined,
    membershipId: service.MembershipId != null ? Number(service.MembershipId) : undefined,
    priority: service.Priority,
  }));

  return {
    services,
    totalServices: totalResults,
  };
}

/**
 * Get packages (bundles of services and products).
 *
 * `GET /sale/packages` (`Mindbody.PublicApi.Dto.Models.V6.Package`).
 *
 * The request accepts only `request.locationId`, `request.packageIds`,
 * `request.sellOnline` (plus paging). `classScheduleId` was dropped: it is not
 * in the spec and the sandbox silently ignores it (C-20 — a `ClassScheduleId`
 * that matches nothing still returns the full list).
 *
 * `Package` is `{ DiscountPercentage, Id, Name, Products[], SellOnline,
 * Services[] }`. Removed output fields, none of which exist on `Package`:
 * - `taxIncluded`, `active`, `productId` — dropped outright; no spec field and
 *   no sandbox key. `ProductId` is replaced by the real `products` sub-list.
 * - `onlinePrice` — dropped as a package-level field. A package has no price of
 *   its own, and its services disagree on online price, so a single value would
 *   be a fabrication. Per-service online price is in `services[].onlinePrice`,
 *   and authoritatively at `GET /sale/services`.
 *
 * `price` and `classCount` are DERIVED, not read: `Package` has neither. Both
 * are sums over the nested `Services[]` (which is a `Service[]`, so `Count` and
 * `Price` are real spec fields). `price` is therefore the package's list value
 * before `discountPercentage` is applied; the authoritative per-service price is
 * `GET /sale/services`. Both are `undefined` when `Services[]` is empty or absent.
 */
export async function getPackagesTool(
  locationId?: number,
  packageIds?: number[],
  sellOnline?: boolean,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  packages: Array<{
    id: number;
    name: string;
    discountPercentage?: number;
    sellOnline?: boolean;
    classCount?: number;
    price?: number;
    services?: Array<{
      id: number;
      name: string;
      count?: number;
      price?: number;
      onlinePrice?: number;
    }>;
    products?: Array<{
      id: string;
      name: string;
      price?: number;
      onlinePrice?: number;
    }>;
  }>;
  totalPackages: number;
}> {
  const { items: packageRows, totalResults } = await fetchAllPages<any>(
    client,
    '/sale/packages',
    {
      LocationId: locationId,
      PackageIds: packageIds,
      SellOnline: sellOnline,
    },
    'Packages'
  );

  const packages = packageRows.map((pkg: any) => {
    const services = Array.isArray(pkg.Services) ? pkg.Services : [];
    const products = Array.isArray(pkg.Products) ? pkg.Products : [];

    return {
      id: pkg.Id,
      name: pkg.Name,
      discountPercentage: pkg.DiscountPercentage != null ? Number(pkg.DiscountPercentage) : undefined,
      sellOnline: pkg.SellOnline,
      classCount:
        services.length > 0
          ? services.reduce((sum: number, s: any) => sum + (s.Count != null ? Number(s.Count) : 0), 0)
          : undefined,
      price:
        services.length > 0
          ? services.reduce((sum: number, s: any) => sum + (s.Price != null ? Number(s.Price) : 0), 0)
          : undefined,
      services:
        services.length > 0
          ? services.map((s: any) => ({
              id: Number(s.Id ?? 0),
              name: s.Name,
              count: s.Count != null ? Number(s.Count) : undefined,
              price: s.Price != null ? Number(s.Price) : undefined,
              onlinePrice: s.OnlinePrice != null ? Number(s.OnlinePrice) : undefined,
            }))
          : undefined,
      products:
        products.length > 0
          ? products.map((p: any) => ({
              id: p.Id,
              name: p.Name,
              price: p.Price != null ? Number(p.Price) : undefined,
              onlinePrice: p.OnlinePrice != null ? Number(p.OnlinePrice) : undefined,
            }))
          : undefined,
    };
  });

  return {
    packages,
    totalPackages: totalResults || packages.length,
  };
}

/**
 * Get products (retail items, equipment).
 *
 * `GET /sale/products` (`Mindbody.PublicApi.Dto.Models.V6.Product`).
 *
 * Removed output fields (C-21 — none of these exist on `Product` in the spec or
 * in any of the 41 sandbox rows; they always rendered as `undefined`):
 * - `category` / `subcategory` — the API returns no category NAMES, only
 *   `CategoryId` / `SubCategoryId` / `SecondaryCategoryId`, so those are exposed
 *   as `categoryId` / `subCategoryId` instead. Resolve a name with `GET /sale/categories`.
 * - `sellOnline` — per-row `SellOnline` does not exist; it is a REQUEST filter.
 *
 * Added: `longDescription` (`LongDescription`), `categoryId` (`CategoryId`),
 * `subCategoryId` (`SubCategoryId`). `description` now reads `ShortDescription`,
 * not the non-existent `Description`.
 */
export async function getProductsTool(
  productIds?: number[],
  searchText?: string,
  categoryIds?: number[],
  subCategoryIds?: number[],
  sellOnline?: boolean,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  products: Array<{
    id: string;
    name: string;
    price: number;
    onlinePrice?: number;
    description?: string;
    longDescription?: string;
    categoryId?: number;
    subCategoryId?: number;
    color?: string;
    size?: string;
    /** The tax amount already included in `price` (spec: "If tax inclusive-pricing
     *  is enabled, this field shows how much tax was added to the price"), so it is
     *  a number and not a flag. */
    taxIncludedAmount?: number;
    taxRate?: number;
  }>;
  totalProducts: number;
}> {
  const { items: productRows, totalResults } = await fetchAllPages<any>(
    client,
    '/sale/products',
    {
      ProductIds: productIds,
      SearchText: searchText,
      CategoryIds: categoryIds,
      SubCategoryIds: subCategoryIds,
      SellOnline: sellOnline,
    },
    'Products'
  );

  const products = productRows.map((product: any) => ({
    id: product.Id,
    name: product.Name,
    price: product.Price,
    onlinePrice: product.OnlinePrice,
    description: product.ShortDescription,
    longDescription: product.LongDescription,
    categoryId: product.CategoryId != null ? Number(product.CategoryId) : undefined,
    subCategoryId: product.SubCategoryId != null ? Number(product.SubCategoryId) : undefined,
    color: product.Color?.Name,
    size: product.Size?.Name,
    taxIncludedAmount: product.TaxIncluded != null ? Number(product.TaxIncluded) : undefined,
    taxRate: product.TaxRate != null ? Number(product.TaxRate) : undefined,
  }));

  return {
    products,
    totalProducts: totalResults || products.length,
  };
}
