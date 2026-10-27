import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { Client, ClientContract, ClientMembership } from '../types/mindbody.js';

/**
 * Client account — what a client holds or owes: memberships, account balance
 * and contracts.
 *
 * Split out of `clientManagement.ts` so each client-domain module stays near
 * the ~200-line guideline. `clientManagement.ts` remains the public barrel.
 */

/**
 * A client's active memberships (`GET /client/activeclientmemberships`).
 *
 * `ClientMembership.Program` is a `Program` object, not a label, so the two
 * fields a caller can use are exposed separately: `programName` from
 * `Program.Name` and `programId` from `Program.Id`. `Program` also carries
 * `ScheduleType`, which is not exposed here; read the membership record
 * directly if you need it.
 */
export async function getClientMembershipsTool(
  clientId: string,
  locationId?: number,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  memberships: Array<{
    id: number;
    name: string;
    remainingClasses?: number;
    activeDate: string;
    expirationDate?: string;
    paymentDate?: string;
    programName?: string;
    programId?: number;
    siteId: number;
    iconCode?: string;
    action?: string;
  }>;
  totalMemberships: number;
}> {
  const { items: membershipRows } = await fetchAllPages<ClientMembership>(
    client,
    '/client/activeclientmemberships',
    {
      ClientId: clientId,
      LocationId: locationId,
    },
    'ClientMemberships'
  );

  const memberships = membershipRows.map((membership: ClientMembership) => ({
    id: membership.Id,
    name: membership.Name,
    remainingClasses: membership.Remaining,
    activeDate: membership.ActiveDate,
    expirationDate: membership.ExpirationDate,
    paymentDate: membership.PaymentDate,
    programName: membership.Program?.Name,
    programId: membership.Program?.Id,
    siteId: membership.SiteId,
    iconCode: membership.IconCode,
    action: membership.Action,
  }));

  return {
    memberships,
    totalMemberships: memberships.length,
  };
}

/**
 * A client's account balance (`GET /client/clientaccountbalances`).
 *
 * The API exposes no per-card balance: `Client.ClientCreditCard` is a single
 * stored card, not a list, and neither `Client` nor `ClientCreditCard` carries a
 * money field for it. What is available is the client's own `AccountBalance`
 * and the stored card's identity (`CardType`, `LastFour`), so
 * `creditCardBalances` is not reported — a balance per card cannot be derived
 * from this endpoint.
 */
export async function getClientAccountBalancesTool(
  clientId: string,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  accountBalance: number;
  creditCard?: {
    cardType?: string;
    lastFour?: string;
  };
}> {
  const { items: balanceRows } = await fetchAllPages<Client>(
    client,
    '/client/clientaccountbalances',
    { ClientIds: [clientId] },
    'Clients'
  );

  const clientData = balanceRows[0];
  const card = clientData?.ClientCreditCard;
  return {
    accountBalance: clientData?.AccountBalance || 0,
    creditCard: card ? {
      cardType: card.CardType,
      lastFour: card.LastFour,
    } : undefined,
  };
}

/**
 * A client's contracts (`GET /client/clientcontracts`).
 *
 * `soldDate` is read from `AgreementDate`, the closest documented equivalent —
 * `ClientContract` has no `SoldDate`.
 *
 * Three fields the tool used to report are not available and are dropped:
 * `description`, `balance` and `contractType`. `ClientContract` has no
 * `Description`, `Balance` or `ContractType` property, and none can be derived
 * from the ones it does carry.
 */
export async function getClientContractsTool(
  clientId: string,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  contracts: Array<{
    id: number;
    contractId?: number;
    name: string;
    soldDate?: string;
    startDate: string;
    endDate?: string;
    autopayStatus?: string;
    autoRenewing?: boolean;
    isMonthToMonth?: boolean;
    terminationDate?: string;
    siteId: number;
  }>;
  totalContracts: number;
}> {
  const { items: contractsRaw, totalResults } = await fetchAllPages<ClientContract>(
    client,
    '/client/clientcontracts',
    { ClientId: clientId },
    'Contracts'
  );

  const contracts = contractsRaw.map((contract: ClientContract) => ({
    id: contract.Id,
    contractId: contract.ContractID,
    name: contract.ContractName,
    soldDate: contract.AgreementDate,
    startDate: contract.StartDate,
    endDate: contract.EndDate,
    autopayStatus: contract.AutopayStatus,
    autoRenewing: contract.AutoRenewing,
    isMonthToMonth: contract.IsMonthToMonth,
    terminationDate: contract.TerminationDate,
    siteId: contract.SiteId,
  }));

  return {
    contracts,
    totalContracts: totalResults || contracts.length,
  };
}
