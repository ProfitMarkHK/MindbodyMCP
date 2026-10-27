/**
 * Client domain — the single import surface for `src/index.ts` and the tests.
 *
 * The tools were split by aspect so each module stays near the ~200-line
 * guideline:
 *   - `clientProfile.ts`  — getClients, addClient, updateClient (identity)
 *   - `clientAccount.ts`  — memberships, contracts, balances (account state)
 *   - `clientActivity.ts` — visits, arrival (attendance)
 *
 * Re-exports are explicit rather than `export *`: a new export in a sub-file is
 * then a reviewable change here, not silent public-surface drift.
 *
 * Do not import this barrel from a `client*` sub-file — that would create an
 * import cycle. Import siblings directly instead.
 */
export { getClientsTool, addClientTool, updateClientTool } from './clientProfile.js';
export {
  getClientMembershipsTool,
  getClientAccountBalancesTool,
  getClientContractsTool,
} from './clientAccount.js';
export { getClientVisitsTool, addClientArrivalTool } from './clientActivity.js';
