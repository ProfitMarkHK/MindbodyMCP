import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { AxiosRequestConfig } from "axios";
import { SpecValidatingClient, SpecValidationError } from "./spec-validating-client.js";
import {
  getServicesTool,
  getPackagesTool,
  getProductsTool,
  checkoutShoppingCartTool,
  purchaseContractTool,
  getContractsTool,
} from "../src/tools/salesManagement.js";
import type { IMindbodyClient } from "../src/api/client.js";

const spec = JSON.parse(
  readFileSync(resolve(__dirname, "../docs/openapi.json"), "utf-8")
);

function makeClient(fixture: unknown) {
  return new SpecValidatingClient(spec, fixture);
}

/**
 * `SpecValidatingClient` does not inspect POST bodies, so C-22 and C-23 use
 * this recorder: it captures the exact body sent and replays a spec-shaped
 * response.
 */
class RecordingClient implements IMindbodyClient {
  bodies: Array<{ url: string; data: any }> = [];

  constructor(private readonly response: unknown) {}

  async post<T>(url: string, data?: any, _config?: AxiosRequestConfig): Promise<T> {
    this.bodies.push({ url, data });
    return this.response as T;
  }

  async request<T>(_config: AxiosRequestConfig, _retries?: number): Promise<T> {
    throw new Error("not used");
  }

  async get<T>(_url: string, _config?: AxiosRequestConfig): Promise<T> {
    throw new Error("not used");
  }
}

// ---------------------------------------------------------------------------
// C-19 — getServicesTool
// ---------------------------------------------------------------------------

// `Mindbody.PublicApi.Dto.Models.V6.Service`, sandbox shape: no SessionTypeId,
// no Prerequisite on any row.
const serviceFixture = {
  Services: [
    {
      Id: "1001",
      Name: "10 Class Pack",
      Price: 200,
      OnlinePrice: 180,
      TaxIncluded: 0,
      TaxRate: 0.0825,
      ProgramId: 9,
      ProductId: 1395,
      Count: 10,
      Type: "Series",
      ExpirationUnit: "Months",
      ExpirationLength: 6,
      MembershipId: 4,
      // Note: the spec types Service.Priority as the STRING "High"/"Medium"/"Low"
      // while this tool coerces it with Number() and declares it `number`. That
      // mismatch predates C-19 and is out of scope here; the fixture uses a
      // number so the assertion exercises only what C-19 touched.
      Priority: "High",
    },
  ],
};

describe("getServicesTool (C-19)", () => {
  it("maps only real Service fields", async () => {
    const result = await getServicesTool(
      undefined, undefined, undefined, undefined, false, makeClient(serviceFixture)
    );
    expect(result.services).toHaveLength(1);
    expect(result.totalServices).toBe(1);

    const service = result.services[0];
    expect(service.id).toBe(1001);
    expect(service.name).toBe("10 Class Pack");
    expect(service.price).toBe(200);
    expect(service.onlinePrice).toBe(180);
    expect(service.taxIncludedAmount).toBe(0);
    expect(service.taxRate).toBe(0.0825);
    expect(service.programId).toBe(9);
    expect(service.count).toBe(10);
    expect(service.expirationUnit).toBe("Months");
    expect(service.expirationLength).toBe(6);
    expect(service.membershipId).toBe(4);
    // Priority is "High" | "Medium" | "Low" in the spec. The old Number() coercion
    // turned it into NaN.
    expect(service.priority).toBe("High");
  });

  it("omits the phantom sessionTypeId and prerequisite fields entirely", async () => {
    const result = await getServicesTool(
      undefined, undefined, undefined, undefined, false, makeClient(serviceFixture)
    );
    const service = result.services[0] as Record<string, unknown>;
    expect(Object.keys(service)).not.toContain("sessionTypeId");
    expect(Object.keys(service)).not.toContain("prerequisite");
  });

  it("sends sessionTypeIds as the session-type filter", async () => {
    // Validates against the spec: SessionTypeIds is a documented request filter.
    const result = await getServicesTool(
      undefined, [23], 1, undefined, false, makeClient(serviceFixture)
    );
    expect(result.services).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// C-20 — getPackagesTool
// ---------------------------------------------------------------------------

// `Mindbody.PublicApi.Dto.Models.V6.Package`:
// { DiscountPercentage, Id, Name, Products[], SellOnline, Services[] }
const packageFixture = {
  Packages: [
    {
      Id: 42,
      Name: "Founders Bundle",
      DiscountPercentage: 15,
      SellOnline: true,
      Services: [
        {
          Id: "1403",
          Name: "Unlimited Month",
          Count: 8,
          Price: 150,
          OnlinePrice: 140,
        },
      ],
      Products: [
        {
          Id: "9001",
          ProductId: 77,
          Name: "Yoga Mat",
          Price: 25,
          OnlinePrice: 25,
        },
      ],
    },
  ],
};

describe("getPackagesTool (C-20)", () => {
  it("maps only real Package fields", async () => {
    const result = await getPackagesTool(1, undefined, undefined, makeClient(packageFixture));
    expect(result.packages).toHaveLength(1);
    expect(result.totalPackages).toBe(1);

    const pkg = result.packages[0];
    expect(pkg.id).toBe(42);
    expect(pkg.name).toBe("Founders Bundle");
    expect(pkg.discountPercentage).toBe(15);
    expect(pkg.sellOnline).toBe(true);
  });

  it("derives classCount and price from Services[]", async () => {
    const result = await getPackagesTool(1, undefined, undefined, makeClient(packageFixture));
    const pkg = result.packages[0];
    expect(pkg.classCount).toBe(8);
    expect(pkg.price).toBe(150);
  });

  it("leaves classCount and price undefined when Services[] is empty", async () => {
    const result = await getPackagesTool(
      1, undefined, undefined, makeClient({ Packages: [{ Id: 7, Name: "Empty", Services: [] }] })
    );
    expect(result.packages[0].classCount).toBeUndefined();
    expect(result.packages[0].price).toBeUndefined();
  });

  it("maps the nested services and products lists", async () => {
    const result = await getPackagesTool(1, undefined, undefined, makeClient(packageFixture));
    expect(result.packages[0].services).toEqual([
      { id: 1403, name: "Unlimited Month", count: 8, price: 150, onlinePrice: 140 },
    ]);
    expect(result.packages[0].products).toEqual([
      { id: "9001", name: "Yoga Mat", price: 25, onlinePrice: 25 },
    ]);
  });

  it("omits the phantom Count/Price/TaxIncluded/Active/ProductId/OnlinePrice package fields", async () => {
    const result = await getPackagesTool(1, undefined, undefined, makeClient(packageFixture));
    const pkg = result.packages[0] as Record<string, unknown>;
    expect(Object.keys(pkg)).not.toContain("taxIncluded");
    expect(Object.keys(pkg)).not.toContain("active");
    expect(Object.keys(pkg)).not.toContain("productId");
    expect(Object.keys(pkg)).not.toContain("onlinePrice");
    expect(Object.keys(pkg)).toContain("classCount");
    expect(Object.keys(pkg)).toContain("price");
  });

  it("no longer sends ClassScheduleId", async () => {
    // The signature is (locationId, packageIds, sellOnline, client); there is no
    // classScheduleId argument to pass, and the request validates cleanly.
    const result = await getPackagesTool(1, [42], true, makeClient(packageFixture));
    expect(result.packages).toHaveLength(1);
  });

  it("rejects a parameter the endpoint does not define", async () => {
    // ClassScheduleId is exactly this: documented nowhere for GET /sale/packages.
    const client = makeClient(packageFixture);
    await expect(
      client.get("/sale/packages", { params: { ClassScheduleId: 999 } })
    ).rejects.toThrow(SpecValidationError);
    await expect(
      client.get("/sale/packages", { params: { ClassScheduleId: 999 } })
    ).rejects.toThrow('Unrecognised query parameter "ClassScheduleId"');
  });

  it("accepts only the documented package filters", async () => {
    const client = makeClient(packageFixture);
    await expect(
      client.get("/sale/packages", { params: { LocationId: 1, PackageIds: [42], SellOnline: true } })
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// C-21 — getProductsTool
// ---------------------------------------------------------------------------

// `Mindbody.PublicApi.Dto.Models.V6.Product`, sandbox shape: ShortDescription /
// LongDescription / CategoryId / SubCategoryId, no Description / Category /
// Subcategory / SellOnline.
const productFixture = {
  Products: [
    {
      Id: "9001",
      ProductId: 77,
      Name: "Manduka Mat",
      Price: 89.95,
      OnlinePrice: 89.95,
      TaxIncluded: 0,
      TaxRate: 0.0825,
      ShortDescription: "Extra-thick mat",
      LongDescription: "A 5mm closed-cell mat with a natural rubber top.",
      CategoryId: 32,
      SubCategoryId: 4,
      SecondaryCategoryId: 9,
      Color: { Id: 3, Name: "Purple" },
      Size: { Id: 2, Name: "Standard" },
    },
  ],
};

describe("getProductsTool (C-21)", () => {
  it("maps ShortDescription, LongDescription and the category ids", async () => {
    const result = await getProductsTool(
      undefined, undefined, undefined, undefined, undefined, makeClient(productFixture)
    );
    expect(result.products).toHaveLength(1);
    expect(result.totalProducts).toBe(1);

    const product = result.products[0];
    expect(product.id).toBe("9001");
    expect(product.name).toBe("Manduka Mat");
    expect(product.price).toBe(89.95);
    expect(product.onlinePrice).toBe(89.95);
    expect(product.description).toBe("Extra-thick mat");
    expect(product.longDescription).toBe("A 5mm closed-cell mat with a natural rubber top.");
    expect(product.categoryId).toBe(32);
    expect(product.subCategoryId).toBe(4);
    expect(product.color).toBe("Purple");
    expect(product.size).toBe("Standard");
    expect(product.taxRate).toBe(0.0825);
    // Product.TaxIncluded is the tax AMOUNT in the spec, so it is reported as a
    // number rather than coerced into a flag.
    expect(product.taxIncludedAmount).toBe(0);
  });

  it("omits category, subcategory and per-row sellOnline", async () => {
    const result = await getProductsTool(
      undefined, undefined, undefined, undefined, undefined, makeClient(productFixture)
    );
    const product = result.products[0] as Record<string, unknown>;
    expect(Object.keys(product)).not.toContain("category");
    expect(Object.keys(product)).not.toContain("subcategory");
    expect(Object.keys(product)).not.toContain("sellOnline");
    expect(Object.keys(product)).toContain("categoryId");
    expect(Object.keys(product)).toContain("subCategoryId");
  });

  it("accepts numeric categoryIds and subCategoryIds", async () => {
    // The spec types request.categoryIds / request.subCategoryIds as integer
    // arrays; number[] is what the tool now takes.
    const result = await getProductsTool(
      undefined, undefined, [32], [4], undefined, makeClient(productFixture)
    );
    expect(result.products).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// C-22 — checkoutShoppingCartTool
// ---------------------------------------------------------------------------

// `CheckoutShoppingCartResponse` -> `CompletedSale.ShoppingCart.CartItems[]`,
// where each `CartItem` is { Item, DiscountAmount, Quantity, Id, VisitIds,
// AppointmentIds, Appointments } and `Item` carries { Id, Name, Count,
// OnlinePrice, Price, TaxRate, ProductId, ProgramId, TaxIncluded }.
const checkoutResponse = {
  ShoppingCart: {
    Id: "cart-1",
    SubTotal: 100,
    DiscountTotal: 10,
    TaxTotal: 8.25,
    GrandTotal: 98.25,
    CartItems: [
      {
        Id: 1,
        Item: {
          Id: 1403,
          Name: "10 Class Pack",
          Count: 10,
          OnlinePrice: 180,
          Price: 100,
          TaxRate: 0.0825,
          ProductId: 1395,
          ProgramId: 9,
          TaxIncluded: 0,
        },
        Quantity: 1,
        DiscountAmount: 10,
        VisitIds: [],
        AppointmentIds: [],
        Appointments: [],
      },
    ],
    Transactions: [],
    SaleId: 555,
  },
  Classes: [],
  Appointments: [],
  Enrollments: [],
};

describe("checkoutShoppingCartTool (C-22)", () => {
  const items = [
    {
      item: { type: "Service" as const, metadata: { id: 1395 } },
      quantity: 1,
    },
  ];
  const payments = [{ type: "Comp" as const, metadata: { amount: 90 } }];

  it("reads name and price from CartItem.Item, not from CartItem", async () => {
    const client = new RecordingClient(checkoutResponse);
    const result = await checkoutShoppingCartTool("c1", items, payments, true, undefined, false, 1, client);

    expect(result.success).toBe(true);
    const item = result.shoppingCart!.items[0];
    expect(item.name).toBe("10 Class Pack");
    expect(item.price).toBe(100);
    expect(item.id).toBe(1);
    expect(item.quantity).toBe(1);
    expect(item.discountAmount).toBe(10);
  });

  it("computes total as price * quantity - discountAmount", async () => {
    const client = new RecordingClient(checkoutResponse);
    const result = await checkoutShoppingCartTool("c1", items, payments, true, undefined, false, 1, client);
    expect(result.shoppingCart!.items[0].total).toBe(90);
  });

  it("passes TaxRate through instead of inventing a line tax", async () => {
    const client = new RecordingClient(checkoutResponse);
    const result = await checkoutShoppingCartTool("c1", items, payments, true, undefined, false, 1, client);
    const item = result.shoppingCart!.items[0] as Record<string, unknown>;
    expect(item.taxRate).toBe(0.0825);
    expect(Object.keys(item)).not.toContain("tax");
  });

  it("keeps the cart envelope totals", async () => {
    const client = new RecordingClient(checkoutResponse);
    const result = await checkoutShoppingCartTool("c1", items, payments, true, undefined, false, 1, client);
    expect(result.shoppingCart!.id).toBe("cart-1");
    expect(result.shoppingCart!.subTotal).toBe(100);
    expect(result.shoppingCart!.discountTotal).toBe(10);
    expect(result.shoppingCart!.taxTotal).toBe(8.25);
    expect(result.shoppingCart!.grandTotal).toBe(98.25);
  });

  it("still sends AppointmentIds when reconciling (D-8)", async () => {
    const client = new RecordingClient(checkoutResponse);
    await checkoutShoppingCartTool(
      "c1",
      [{ ...items[0], appointmentIds: [4321] }],
      payments,
      true,
      undefined,
      false,
      1,
      client
    );
    expect(client.bodies[0].data.Items[0].AppointmentIds).toEqual([4321]);
  });
});

// ---------------------------------------------------------------------------
// D-8 — reconciledAppointmentIds
// ---------------------------------------------------------------------------

describe("reconciledAppointmentIds (D-8)", () => {
  it("reports an empty list, not a failure, when the sandbox reconciles nothing back", async () => {
    // Sandboxed evidence: a committed reconciling sale returns empty
    // Appointments/AppointmentIds. The sale still succeeded.
    const client = new RecordingClient(checkoutResponse);
    const result = await checkoutShoppingCartTool(
      "c1",
      [{ item: { type: "Service", metadata: { id: 1395 } }, quantity: 1, appointmentIds: [4321] }],
      [{ type: "Comp", metadata: { amount: 90 } }],
      true,
      undefined,
      false,
      1,
      client
    );
    expect(result.success).toBe(true);
    expect(result.shoppingCart!.items[0].appointments).toEqual([]);
  });

  it("accepts the documented Appointment[] shape", async () => {
    const withObjects = JSON.parse(JSON.stringify(checkoutResponse));
    withObjects.ShoppingCart.CartItems[0].Appointments = [{ Id: 4321, Status: "Completed" }];
    const client = new RecordingClient(withObjects);
    const result = await checkoutShoppingCartTool(
      "c1",
      [{ item: { type: "Service", metadata: { id: 1395 } }, quantity: 1 }],
      [{ type: "Comp", metadata: { amount: 90 } }],
      true,
      undefined,
      false,
      1,
      client
    );
    expect(result.shoppingCart!.items[0].appointments).toEqual([4321]);
  });
});

// ---------------------------------------------------------------------------
// C-23 — purchaseContractTool
// ---------------------------------------------------------------------------

// `PurchaseContractResponse` is FLAT:
// { ClientId, UniqueClientId, LocationId, ContractId, ClientContractId,
//   Totals, PaymentProcessingFailures } — there is no `ClientContract` object.
const purchaseContractResponse = {
  ClientId: "c1",
  UniqueClientId: 987,
  LocationId: 1,
  ContractId: 5,
  ClientContractId: 42,
  Totals: {
    Total: 250,
    TransactionFee: 0,
    SubTotal: 231.48,
    Discount: 0,
    Tax: 18.52,
  },
  PaymentProcessingFailures: [
    {
      Type: "SCAChallenge",
      Message: "Additional authentication required",
      AuthenticationRedirectUrl: "https://example.test/challenge",
    },
  ],
};

describe("purchaseContractTool (C-23)", () => {
  it("reads the flat response instead of a ClientContract object", async () => {
    const client = new RecordingClient(purchaseContractResponse);
    const result = await purchaseContractTool("c1", 5, "2026-01-01", undefined, undefined, undefined, 1, undefined, client);

    expect(result.success).toBe(true);
    expect(result.clientContractId).toBe(42);
    expect(result.contractId).toBe(5);
    expect(result.clientId).toBe("c1");
    expect(result.locationId).toBe(1);
    expect(result.totals).toEqual({ subTotal: 231.48, discount: 0, tax: 18.52, total: 250 });
  });

  it("surfaces paymentProcessingFailures", async () => {
    const client = new RecordingClient(purchaseContractResponse);
    const result = await purchaseContractTool("c1", 5, "2026-01-01", undefined, undefined, undefined, 1, undefined, client);
    expect(result.paymentProcessingFailures).toEqual([
      {
        type: "SCAChallenge",
        message: "Additional authentication required",
        authenticationRedirectUrl: "https://example.test/challenge",
      },
    ]);
  });

  it("sends the documented request body", async () => {
    const client = new RecordingClient(purchaseContractResponse);
    await purchaseContractTool("c1", 5, "2026-01-01", "UponSale", "sig", "PROMO", 1, undefined, client);
    expect(client.bodies[0].url).toBe("/sale/purchasecontract");
    expect(client.bodies[0].data).toEqual({
      ClientId: "c1",
      ContractId: 5,
      StartDate: "2026-01-01",
      FirstPaymentOccurs: "UponSale",
      ClientSignature: "sig",
      PromotionCode: "PROMO",
      LocationId: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// C-24 / C-25 — getContractsTool
// ---------------------------------------------------------------------------

// `Mindbody.PublicApi.Dto.Models.V6.Contract`: no ContractType, no LocationId,
// IntroOffer is a string, AutopaySchedule has exactly three fields.
const contractFixture = {
  Contracts: [
    {
      Id: 5,
      Name: "12 Month Unlimited",
      Description: "Unlimited classes for twelve months",
      AssignsMembershipId: 4,
      AssignsMembershipName: "Unlimited",
      SoldOnline: true,
      ContractItems: [],
      IntroOffer: "NewAndReturningConsumer",
      AutopaySchedule: {
        FrequencyType: "SetNumberOfAutopays",
        FrequencyValue: 1,
        FrequencyTimeUnit: "Monthly",
      },
      NumberOfAutopays: 12,
      AutopayTriggerType: "SetDate",
      AgreementTerms: "Cancel any time with 30 days notice.",
      AutopayEnabled: true,
      FirstPaymentAmountTotal: 250,
      RecurringPaymentAmountTotal: 249,
      TotalContractAmountTotal: 2988,
    },
    {
      Id: 6,
      Name: "No Autopay Plan",
      IntroOffer: "None",
      AutopaySchedule: null,
      SoldOnline: false,
      AutopayEnabled: false,
    },
  ],
};

describe("getContractsTool (C-24)", () => {
  it("validates when locationId is supplied", async () => {
    // locationId is now a required tool parameter, so a call without one does
    // not compile; this asserts the request the tool builds satisfies the spec,
    // which marks request.locationId required.
    const result = await getContractsTool(1, undefined, undefined, makeClient(contractFixture));
    expect(result.contracts).toHaveLength(2);
    expect(result.totalContracts).toBe(2);
  });

  it("the spec marks request.locationId required, and the validator enforces it", async () => {
    const client = makeClient(contractFixture);
    await expect(
      client.get("/sale/contracts", { params: { Limit: 200, Offset: 0 } })
    ).rejects.toThrow(SpecValidationError);
    await expect(
      client.get("/sale/contracts", { params: { Limit: 200, Offset: 0 } })
    ).rejects.toThrow('Missing required query parameter "request.locationId"');
  });

  it("accepts contractIds and soldOnline alongside locationId", async () => {
    const result = await getContractsTool(1, [5, 6], true, makeClient(contractFixture));
    expect(result.contracts).toHaveLength(2);
  });
});

describe("getContractsTool (C-25)", () => {
  it("maps only real Contract fields", async () => {
    const result = await getContractsTool(1, undefined, undefined, makeClient(contractFixture));
    const contract = result.contracts[0];

    expect(contract.id).toBe(5);
    expect(contract.name).toBe("12 Month Unlimited");
    expect(contract.description).toBe("Unlimited classes for twelve months");
    expect(contract.assignsMembershipId).toBe(4);
    expect(contract.assignsMembershipName).toBe("Unlimited");
    expect(contract.soldOnline).toBe(true);
    expect(contract.agreementTerms).toBe("Cancel any time with 30 days notice.");
    expect(contract.introOffer).toBe("NewAndReturningConsumer");
  });

  it("maps the three-field AutopaySchedule with the Contract-level money field", async () => {
    const result = await getContractsTool(1, undefined, undefined, makeClient(contractFixture));
    expect(result.contracts[0].autopaySchedule).toEqual({
      frequencyType: "SetNumberOfAutopays",
      frequencyValue: 1,
      frequencyTimeUnit: "Monthly",
      recurringPaymentAmountTotal: 249,
    });
  });

  it("leaves autopaySchedule undefined when the contract has none", async () => {
    const result = await getContractsTool(1, undefined, undefined, makeClient(contractFixture));
    expect(result.contracts[1].autopaySchedule).toBeUndefined();
    expect(result.contracts[1].introOffer).toBe("None");
  });

  it("omits contractType, locationId and autopaySchedule.paymentAmount", async () => {
    const result = await getContractsTool(1, undefined, undefined, makeClient(contractFixture));
    const contract = result.contracts[0] as Record<string, unknown>;
    expect(Object.keys(contract)).not.toContain("contractType");
    expect(Object.keys(contract)).not.toContain("locationId");

    const schedule = contract.autopaySchedule as Record<string, unknown>;
    expect(Object.keys(schedule)).not.toContain("paymentAmount");
    expect(Object.keys(schedule)).not.toContain("frequency");
    expect(Object.keys(schedule)).not.toContain("duration");
  });
});