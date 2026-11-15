import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { errorMessage } from '../utils/errors.js';

/**
 * Purchase a contract (membership / auto-renew).
 *
 * ── Why `useAccountCredit` exists ───────────────────────────────────────────
 * `/sale/purchasecontract` answers HTTP 400 `MissingRequiredFields` — "At
 * least one of the following parameters must be passed: CreditCardInfo,
 * StoredCardInfo, UseDirectDebit, UseAccountCredit" — unless one of those four
 * is present. Three of the four are real payment instruments. `UseAccountCredit`
 * is NOT: it is a boolean meaning "bill this to the client's account balance",
 * and the sandbox accepts it with a zero balance, committing the contract and
 * leaving the charge on account. It is therefore the only way to exercise this
 * endpoint without handing Mindbody payment details, and the reason the live
 * tier can test it at all.
 *
 * The other three are deliberately NOT exposed. This server takes no card
 * numbers, no stored-card ids and no bank details (see the no-op policy in
 * tests/live/README.md), so exposing them would widen the surface for no
 * caller that is allowed to use them.
 *
 * ── Response shape ──────────────────────────────────────────────────────────
 * `PurchaseContractResponse` in docs/openapi.json carries `ClientId,
 * UniqueClientId, LocationId, ContractId, ClientContractId,
 * PaymentProcessingFailures, Totals`. It has NO nested `ClientContract`
 * object — an earlier version of this tool read `response.ClientContract.Id`,
 * which threw on every successful purchase and reported the success as a
 * failure. `ClientContractId` is the id of the ClientContract that was created;
 * read it back through `getClientContracts`.
 */
export async function purchaseContractTool(
  clientId: string,
  contractId: number,
  startDate: string,
  firstPaymentOccurs?: 'StartDate' | 'UponSale' | 'BillingDate',
  clientSignature?: string,
  promotionCode?: string,
  locationId?: number,
  useAccountCredit?: boolean,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  success: boolean;
  /** The id of the ClientContract that was created; `null` on a dry run. */
  clientContractId?: number | null;
  clientId?: string;
  contractId?: number;
  locationId?: number;
  totals?: { subTotal: number; discount: number; tax: number; total: number };
  paymentProcessingFailures?: Array<{ type: string; message: string; authenticationRedirectUrl?: string }>;
  message: string;
}> {
  try {
    // SPEC-ALIGNED BUT UNVERIFIED: POST /sale/purchasecontract cannot be exercised on the sandbox (it rejects the call before producing a body unless a payment instrument is supplied), so the response shape below is taken from docs/openapi.json alone.
    // Recorded in docs/mindbody-spec-discrepancies.md section E-3.
    const response = await client.post<any>('/sale/purchasecontract', {
      ClientId: clientId,
      ContractId: contractId,
      StartDate: startDate,
      FirstPaymentOccurs: firstPaymentOccurs || 'StartDate',
      ClientSignature: clientSignature,
      PromotionCode: promotionCode,
      LocationId: locationId,
      UseAccountCredit: useAccountCredit,
    });

    // `PurchaseContractResponse` is FLAT:
    // { ClientId, UniqueClientId, LocationId, ContractId, ClientContractId,
    //   Totals, PaymentProcessingFailures }. There is no `ClientContract`
    // object; reading one used to throw on every successful purchase and the
    // catch below then reported `success: false` for a sale that had committed.
    // `contractName`, `startDate`, `endDate`, `paymentAmount`, `frequency` and
    // `remainingPayments` are dropped — none exist on the response. A purchased
    // contract's detail is at `GET /client/clientcontracts`.
    return {
      success: true,
      clientContractId: response.ClientContractId ?? null,
      clientId: response.ClientId,
      contractId: response.ContractId,
      locationId: response.LocationId,
      totals: response.Totals
        ? {
            subTotal: response.Totals.SubTotal,
            discount: response.Totals.Discount,
            tax: response.Totals.Tax,
            total: response.Totals.Total,
          }
        : undefined,
      paymentProcessingFailures: response.PaymentProcessingFailures?.map((failure: any) => ({
        type: failure.Type,
        message: failure.Message,
        authenticationRedirectUrl: failure.AuthenticationRedirectUrl,
      })),
      message: 'Contract purchased successfully',
    };
  } catch (error: unknown) {
    return {
      success: false,
      message: errorMessage(error, 'Failed to purchase contract'),
    };
  }
}

/**
 * Get contracts (membership types).
 *
 * `GET /sale/contracts` (`Mindbody.PublicApi.Dto.Models.V6.Contract`).
 *
 * `locationId` is REQUIRED: the spec marks `request.locationId` required and the
 * sandbox answers HTTP 400 `LocationId is a required parameter.
 * (MissingRequiredFields)` without it. It is never defaulted or resolved from a
 * catalogue, so a caller cannot silently ask for "all locations".
 *
 * Removed output fields, none of which exist on `Contract`:
 * - `contractType` — unavailable. `Contract` has no type discriminator; the
 *   closest real fields are `AutopayTriggerType` and `ClientsChargedOn`, which
 *   are left out rather than renamed into something they are not.
 * - `locationId` — unavailable on the row. Contracts are scoped by the request's
 *   `locationId`, which the caller already supplied.
 * - `autopaySchedule.paymentAmount` — `AutopaySchedule` is only
 *   `{ FrequencyType, FrequencyValue, FrequencyTimeUnit }`. The money fields
 *   live on `Contract`: `FirstPaymentAmountTotal`,
 *   `RecurringPaymentAmountTotal`, `TotalContractAmountTotal`. The first two
 *   are exposed; `totalContractAmountTotal` is not yet mapped.
 * - `introOffer` as an object — `Contract.IntroOffer` is a STRING ("None",
 *   "NewAndReturningConsumer"), so `introOffer` is now `string | undefined`.
 */
export async function getContractsTool(
  locationId: number,
  contractIds?: number[],
  soldOnline?: boolean,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  contracts: Array<{
    id: number;
    name: string;
    description?: string;
    assignsMembershipId?: number;
    assignsMembershipName?: string;
    soldOnline: boolean;
    agreementTerms?: string;
    autopaySchedule?: {
      frequencyType: string;
      frequencyValue?: number;
      frequencyTimeUnit?: string;
      recurringPaymentAmountTotal?: number;
    };
    introOffer?: string;
  }>;
  totalContracts: number;
}> {
  const { items: contractRows, totalResults } = await fetchAllPages<any>(
    client,
    '/sale/contracts',
    {
      LocationId: locationId,
      ContractIds: contractIds,
      SoldOnline: soldOnline,
    },
    'Contracts'
  );

  const contracts = contractRows.map((contract: any) => ({
    id: contract.Id,
    name: contract.Name,
    description: contract.Description,
    assignsMembershipId: contract.AssignsMembershipId,
    assignsMembershipName: contract.AssignsMembershipName,
    soldOnline: contract.SoldOnline,
    agreementTerms: contract.AgreementTerms,
    autopaySchedule: contract.AutopaySchedule ? {
      frequencyType: contract.AutopaySchedule.FrequencyType,
      frequencyValue: contract.AutopaySchedule.FrequencyValue,
      frequencyTimeUnit: contract.AutopaySchedule.FrequencyTimeUnit,
      recurringPaymentAmountTotal: contract.RecurringPaymentAmountTotal,
    } : undefined,
    introOffer: contract.IntroOffer,
  }));

  return {
    contracts,
    totalContracts: totalResults || contracts.length,
  };
}
