/**
 * Sales domain — the single import surface for `src/index.ts` and the tests.
 *
 * The tools were split by aspect so each module stays near the ~200-line
 * guideline:
 *   - `salesCatalogue.ts` — getServices, getPackages, getProducts (catalogue reads)
 *   - `salesContracts.ts` — getContracts, purchaseContract (membership contracts)
 *   - `salesCheckout.ts`  — checkoutShoppingCart, getCustomPaymentMethods (payments)
 *
 * `getSales` lives in `salesHistory.ts` and is imported directly, not from here.
 *
 * Re-exports are explicit rather than `export *`: a new export in a sub-file is
 * then a reviewable change here, not silent public-surface drift.
 *
 * Do not import this barrel from a `sales*` sub-file — that would create an
 * import cycle. Import siblings directly instead.
 */
export { getServicesTool, getPackagesTool, getProductsTool } from './salesCatalogue.js';
export { getContractsTool, purchaseContractTool } from './salesContracts.js';
export { checkoutShoppingCartTool, getCustomPaymentMethodsTool } from './salesCheckout.js';
