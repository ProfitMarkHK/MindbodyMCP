#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

// Import all tools
import { getTeacherScheduleTool } from './tools/teacherSchedule.js';
import {
  getClassesTool,
  getClassDescriptionsTool,
  addClientToClassTool,
  removeClientFromClassTool,
  getWaitlistEntriesTool,
  substituteClassTeacherTool,
  getClassSchedulesTool,
  getClassVisitsTool,
} from './tools/classManagement.js';
import {
  getClientsTool,
  addClientTool,
  updateClientTool,
  getClientVisitsTool,
  getClientMembershipsTool,
  addClientArrivalTool,
  getClientAccountBalancesTool,
  getClientContractsTool,
} from './tools/clientManagement.js';
import {
  getServicesTool,
  getPackagesTool,
  getProductsTool,
  checkoutShoppingCartTool,
  purchaseContractTool,
  getContractsTool,
} from './tools/salesManagement.js';
import {
  getSitesTool,
  getLocationsTool,
  getProgramsTool,
  getResourcesTool,
  getSessionTypesTool,
  getStaffTool,
  getActivationCodeTool,
} from './tools/siteManagement.js';
import {
  getStaffAppointmentsTool,
  addAppointmentTool,
  updateAppointmentTool,
  cancelAppointmentsTool,
  MAX_CANCELLATIONS_PER_REQUEST,
  UPDATE_APPOINTMENT_EXECUTE_VALUES,
  type UpdateAppointmentExecute,
  getBookableItemsTool,
  getActiveSessionTimesTool,
  getScheduleItemsTool,
} from './tools/appointmentManagement.js';
import {
  getEnrollmentsTool,
  addClientToEnrollmentTool,
  getClientEnrollmentsTool,
  cancelEnrollmentVisitsTool,
  MAX_ENROLLMENT_CANCELLATIONS_PER_REQUEST,
} from './tools/enrollmentManagement.js';

// Usage text. Printed for --help/-h before anything else, so it works with no
// .env, no credentials and no network.
const USAGE = `Mindbody MCP Server v2.0

Usage: mindbody-mcp [options]

Options:
  -t, --transport <stdio|sse>  Transport to serve (default: stdio)
  -p, --port <number>          Port for the SSE transport (default: 3000)
      --host <hostname>        Host to bind for SSE (default: 0.0.0.0)
      --ssl-cert <path>        TLS certificate; requires --ssl-key
      --ssl-key <path>         TLS private key; requires --ssl-cert
  -h, --help                   Show this help and exit

See README.md for full setup and tool documentation.`;

/**
 * True when --help or -h was passed. Note that -h previously aliased --host;
 * help is the conventional meaning of -h, so --host is now the long form only.
 */
function isHelpRequested(): boolean {
  return process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h');
}

if (isHelpRequested()) {
  console.log(USAGE);
  process.exit(0);
}

// Validate required environment variables
const requiredEnvVars = [
  'MINDBODY_API_KEY',
  'MINDBODY_SITE_ID',
  'MINDBODY_SOURCE_NAME',
  'MINDBODY_SOURCE_PASSWORD'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    console.error('Please copy .env.example to .env and fill in your credentials');
    process.exit(1);
  }
}

// Tool handlers live at module scope so that every SSE connection can be given
// its own freshly configured Server (see createMcpServer). Sharing a single
// Server instance across concurrent clients leaks per-session state between
// them - advisory GHSA-345p-7cg4-v4c7.
const listToolsHandler = async (): Promise<ListToolsResult> => {
  return {
    tools: [
      // Teacher/Staff Tools
      {
        name: 'getTeacherSchedule',
        description: 'Get a teacher\'s class schedule for a specified date range',
        inputSchema: {
          type: 'object',
          properties: {
            teacherName: { type: 'string', description: 'The name of the teacher' },
            startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
            endDate: { type: 'string', description: 'End date in YYYY-MM-DD format' },
          },
          required: ['teacherName'],
        },
      },
      {
        name: 'getStaff',
        description: 'Get all staff members with optional filters. `sessionTypeId` and `locationId` are SINGLE ids — the API has no plural form of either, and the plural spelling is silently ignored. They only narrow the result when `startDateTime` is also supplied.',
        inputSchema: {
          type: 'object',
          properties: {
            staffIds: { type: 'array', items: { type: 'number' }, description: 'Specific staff IDs to retrieve' },
            filters: { type: 'array', items: { type: 'string' }, description: 'Filters to apply' },
            sessionTypeId: { type: 'number', description: 'Session type ID (single id, not a list)' },
            locationId: { type: 'number', description: 'Location ID (single id, not a list)' },
            startDateTime: { type: 'string', description: 'Start date/time in ISO format; required for sessionTypeId/locationId to narrow' },
          },
        },
      },
      
      // Class Management Tools
      {
        name: 'getClasses',
        description: 'Get all classes with filtering options',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
            endDate: { type: 'string', description: 'End date in YYYY-MM-DD format' },
            locationIds: { type: 'array', items: { type: 'number' }, description: 'Location IDs to filter by' },
            classDescriptionIds: { type: 'array', items: { type: 'number' }, description: 'Class description IDs' },
            staffIds: { type: 'array', items: { type: 'number' }, description: 'Staff IDs to filter by' },
          },
        },
      },
      {
        name: 'getClassDescriptions',
        description: 'Get all class types/descriptions offered',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'getClassSchedules',
        description: 'Get class schedules (recurring class templates). `days` lists the weekdays each schedule runs on, built from the schedule\'s seven Day* flags, and `isAvailable` is the schedule\'s own availability flag. `sessionTypeIds` filters by session type; there is no class-description filter on this endpoint.',
        inputSchema: {
          type: 'object',
          properties: {
            locationIds: { type: 'array', items: { type: 'number' }, description: 'Location IDs' },
            sessionTypeIds: { type: 'array', items: { type: 'number' }, description: 'Session type IDs' },
            staffIds: { type: 'array', items: { type: 'number' }, description: 'Staff IDs' },
            programIds: { type: 'array', items: { type: 'number' }, description: 'Program IDs' },
          },
        },
      },
      {
        name: 'addClientToClass',
        description: 'Book a client into a class',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID' },
            classId: { type: 'number', description: 'Class ID to book' },
            requirePayment: { type: 'boolean', description: 'Require payment (default true)' },
            waitlist: { type: 'boolean', description: 'Add to waitlist if full (default false)' },
          },
          required: ['clientId', 'classId'],
        },
      },
      {
        name: 'removeClientFromClass',
        description: 'Cancel a client\'s class booking',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID' },
            classId: { type: 'number', description: 'Class ID' },
            lateCancel: { type: 'boolean', description: 'Mark as late cancel (default false)' },
          },
          required: ['clientId', 'classId'],
        },
      },
      {
        name: 'getWaitlistEntries',
        description: 'Get waitlist entries for classes. At least one of classScheduleIds, classIds or clientIds is REQUIRED: the API answers HTTP 400 MissingRequiredFields when it receives none of ClassScheduleIds, ClientIds, WaitlistEntryIds or ClassIds. Entries carry no queue position — the endpoint has no such field.',
        inputSchema: {
          type: 'object',
          properties: {
            classScheduleIds: { type: 'array', items: { type: 'number' }, description: 'Class schedule IDs' },
            classIds: { type: 'array', items: { type: 'number' }, description: 'Class IDs' },
            clientIds: { type: 'array', items: { type: 'string' }, description: 'Client IDs' },
          },
        },
      },
      {
        name: 'substituteClassTeacher',
        description: 'Substitute the teacher for a class. The API takes the INCOMING teacher\'s staff id in `substituteTeacherId`; the original teacher is implied by the class, so it is not a parameter. The response is unverified against the sandbox (the endpoint has no Test flag) — see the tool documentation.',
        inputSchema: {
          type: 'object',
          properties: {
            classId: { type: 'number', description: 'Class ID' },
            substituteTeacherId: { type: 'number', description: 'Substitute (incoming) teacher staff ID' },
          },
          required: ['classId', 'substituteTeacherId'],
        },
      },
      {
        name: 'getClassVisits',
        description: 'Get client visits/attendance for a specific class. Returns all clients who booked or attended the class, including sign-in status, late cancellations, and service information.',
        inputSchema: {
          type: 'object',
          properties: {
            classId: { type: 'number', description: 'The ID of the class to get visits for' },
            lastModifiedDate: { type: 'string', description: 'Only return visits modified after this date (YYYY-MM-DD format)' },
          },
          required: ['classId'],
        },
      },

      // Client Management Tools
      {
        name: 'getClients',
        description: 'Search and retrieve clients',
        inputSchema: {
          type: 'object',
          properties: {
            searchText: { type: 'string', description: 'Search text for client name/email/phone' },
            clientIds: { type: 'array', items: { type: 'string' }, description: 'Specific client IDs' },
            lastModifiedDate: { type: 'string', description: 'Get clients modified after this date' },
            isProspect: { type: 'boolean', description: 'Filter for prospects only' },
          },
        },
      },
      {
        name: 'addClient',
        description: 'Add a new client',
        inputSchema: {
          type: 'object',
          properties: {
            firstName: { type: 'string', description: 'First name' },
            lastName: { type: 'string', description: 'Last name' },
            email: { type: 'string', description: 'Email address' },
            mobilePhone: { type: 'string', description: 'Mobile phone' },
            birthDate: { type: 'string', description: 'Birth date in YYYY-MM-DD format' },
            addressLine1: { type: 'string', description: 'Street address' },
            city: { type: 'string', description: 'City' },
            state: { type: 'string', description: 'State/Province' },
            postalCode: { type: 'string', description: 'Postal code' },
            country: { type: 'string', description: 'Country' },
            emergencyContactName: { type: 'string', description: 'Emergency contact name' },
            emergencyContactPhone: { type: 'string', description: 'Emergency contact phone' },
            emergencyContactRelationship: { type: 'string', description: 'Emergency contact relationship' },
            sendAccountEmails: { type: 'boolean', description: 'Send account emails (default true)' },
            referredBy: { type: 'string', description: 'Referral source' },
          },
          required: ['firstName', 'lastName'],
        },
      },
      {
        name: 'updateClient',
        description: 'Update client information',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID to update' },
            updates: {
              type: 'object',
              properties: {
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                email: { type: 'string' },
                mobilePhone: { type: 'string' },
                birthDate: { type: 'string' },
                addressLine1: { type: 'string' },
                city: { type: 'string' },
                state: { type: 'string' },
                postalCode: { type: 'string' },
                emergencyContactName: { type: 'string' },
                emergencyContactPhone: { type: 'string' },
                sendAccountEmails: { type: 'boolean' },
              },
            },
          },
          required: ['clientId', 'updates'],
        },
      },
      {
        name: 'getClientVisits',
        description: 'Get client\'s visit/attendance history',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID' },
            startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
            endDate: { type: 'string', description: 'End date in YYYY-MM-DD format' },
          },
          required: ['clientId'],
        },
      },
      {
        name: 'getClientMemberships',
        description: 'Get client\'s active memberships',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID' },
            locationId: { type: 'number', description: 'Location ID (optional)' },
          },
          required: ['clientId'],
        },
      },
      {
        name: 'addClientArrival',
        description: 'Check in a client (mark arrival)',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID' },
            locationId: { type: 'number', description: 'Location ID' },
          },
          required: ['clientId', 'locationId'],
        },
      },
      {
        name: 'getClientAccountBalances',
        description: 'Get client\'s account balances',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID' },
          },
          required: ['clientId'],
        },
      },
      {
        name: 'getClientContracts',
        description: 'Get client\'s contracts/memberships',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID' },
          },
          required: ['clientId'],
        },
      },
      
      // Sales & Commerce Tools
      {
        name: 'getServices',
        description: 'Get available services (class packages, memberships)',
        inputSchema: {
          type: 'object',
          properties: {
            programIds: { type: 'array', items: { type: 'number' }, description: 'Program IDs' },
            sessionTypeIds: { type: 'array', items: { type: 'number' }, description: 'Session type IDs' },
            locationId: { type: 'number', description: 'Location ID' },
            classId: { type: 'number', description: 'Class ID' },
            hideRelatedPrograms: { type: 'boolean', description: 'Hide related programs' },
          },
        },
      },
      {
        name: 'getPackages',
        description: 'Get class packages. A package has no price of its own: classCount and price are summed from the services it contains, and per-service prices are in services[].',
        inputSchema: {
          type: 'object',
          properties: {
            locationId: { type: 'number', description: 'Location ID' },
            packageIds: { type: 'array', items: { type: 'number' }, description: 'Package IDs' },
            sellOnline: { type: 'boolean', description: 'Only packages that can be sold online' },
          },
        },
      },
      {
        name: 'getProducts',
        description: 'Get retail products',
        inputSchema: {
          type: 'object',
          properties: {
            productIds: { type: 'array', items: { type: 'number' }, description: 'Product IDs' },
            searchText: { type: 'string', description: 'Search text' },
            categoryIds: { type: 'array', items: { type: 'number' }, description: 'Category IDs' },
            subCategoryIds: { type: 'array', items: { type: 'number' }, description: 'Subcategory IDs' },
            sellOnline: { type: 'boolean', description: 'Filter for online products' },
          },
        },
      },
      {
        name: 'getContracts',
        description: 'Get available contracts/memberships. `locationId` is REQUIRED: the API answers HTTP 400 MissingRequiredFields without it. Categories of a product and the type of a contract are not returned by the API, so only their ids are exposed.',
        inputSchema: {
          type: 'object',
          properties: {
            locationId: { type: 'number', description: 'Location ID (required)' },
            contractIds: { type: 'array', items: { type: 'number' }, description: 'Contract IDs' },
            soldOnline: { type: 'boolean', description: 'Filter for online contracts' },
          },
          required: ['locationId'],
        },
      },
      {
        name: 'checkoutShoppingCart',
        description: 'Process a shopping cart checkout',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID' },
            items: {
              type: 'array',
              description: 'Cart items',
              items: {
                type: 'object',
                properties: {
                  item: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['Service', 'Product', 'Package', 'Tip'] },
                      metadata: { type: 'object' },
                    },
                  },
                  quantity: { type: 'number' },
                  appointmentIds: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Existing appointment IDs this item pays for (reconciles)',
                  },
                },
              },
            },
            payments: {
              type: 'array',
              description: 'Payment methods',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['Cash', 'Check', 'CreditCard', 'Comp', 'Custom', 'StoredCard'] },
                  metadata: { type: 'object' },
                },
              },
            },
            inStore: { type: 'boolean', description: 'In-store purchase' },
            promotionCode: { type: 'string', description: 'Promotion code' },
            sendEmail: { type: 'boolean', description: 'Send email receipt' },
            locationId: { type: 'number', description: 'Location ID' },
          },
          required: ['clientId', 'items', 'payments'],
        },
      },
      {
        name: 'purchaseContract',
        description: 'Purchase a contract/membership',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID' },
            contractId: { type: 'number', description: 'Contract ID' },
            startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
            firstPaymentOccurs: { type: 'string', enum: ['StartDate', 'UponSale', 'BillingDate'] },
            clientSignature: { type: 'string', description: 'Client signature' },
            promotionCode: { type: 'string', description: 'Promotion code' },
            locationId: { type: 'number', description: 'Location ID' },
            useAccountCredit: {
              type: 'boolean',
              description:
                'Bill the contract to the client account balance instead of a payment method. This endpoint ' +
                'refuses the request unless one of CreditCardInfo, StoredCardInfo, UseDirectDebit or ' +
                'UseAccountCredit is supplied, and this server exposes only this one — it takes no card or ' +
                'bank details. It is accepted against a zero balance: the contract commits and the charge is ' +
                'left on the client account.',
            },
          },
          required: ['clientId', 'contractId', 'startDate'],
        },
      },
      
      // Site & Location Tools
      {
        name: 'getSites',
        description:
          'Get site/business information for the site this server operates on. If the API key reaches more than one site, no site data is returned unless MINDBODY_SITE_ID is configured or siteId is passed; the response then lists availableSites instead.',
        inputSchema: {
          type: 'object',
          properties: {
            siteId: { type: 'string', description: 'Explicit site ID to query (overrides the configured default)' },
          },
        },
      },
      {
        name: 'getLocations',
        description: 'Get all studio locations',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'getPrograms',
        description: 'Get programs (yoga, pilates, etc.)',
        inputSchema: {
          type: 'object',
          properties: {
            scheduleType: { type: 'string', enum: ['All', 'Class', 'Enrollment', 'Appointment'] },
            onlineOnly: { type: 'boolean', description: 'Online programs only' },
          },
        },
      },
      {
        name: 'getResources',
        description: 'Get resources (rooms, equipment). Only the filters below are sent: the endpoint has no session-type or date filter, and passing an undocumented `sessionTypeIds` to it returns HTTP 500 rather than being ignored.',
        inputSchema: {
          type: 'object',
          properties: {
            locationIds: { type: 'array', items: { type: 'number' }, description: 'Location IDs' },
            programIds: { type: 'array', items: { type: 'number' }, description: 'Program IDs' },
            resourceIds: { type: 'array', items: { type: 'number' }, description: 'Resource IDs' },
            scheduleTypes: { type: 'array', items: { type: 'string' }, description: 'Schedule types' },
            includeInactive: { type: 'boolean', description: 'Include inactive resources' },
          },
        },
      },
      {
        name: 'getSessionTypes',
        description: 'Get session types (class types, appointment types)',
        inputSchema: {
          type: 'object',
          properties: {
            programIds: { type: 'array', items: { type: 'number' }, description: 'Program IDs' },
            onlineOnly: { type: 'boolean', description: 'Online sessions only' },
          },
        },
      },
      {
        name: 'getActivationCode',
        description: 'Get site activation code',
        inputSchema: { type: 'object', properties: {} },
      },
      
      // Appointment Tools
      {
        name: 'getStaffAppointments',
        description: 'Get staff appointments',
        inputSchema: {
          type: 'object',
          properties: {
            staffIds: { type: 'array', items: { type: 'number' }, description: 'Staff IDs' },
            locationIds: { type: 'array', items: { type: 'number' }, description: 'Location IDs' },
            startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
            endDate: { type: 'string', description: 'End date in YYYY-MM-DD format' },
            appointmentIds: { type: 'array', items: { type: 'number' }, description: 'Appointment IDs' },
            clientId: { type: 'string', description: 'Client ID (a single client)' },
          },
          required: [],
        },
      },
      {
        name: 'addAppointment',
        description: 'Book an appointment',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID' },
            staffId: { type: 'number', description: 'Staff ID' },
            locationId: { type: 'number', description: 'Location ID' },
            sessionTypeId: { type: 'number', description: 'Session type ID' },
            startDateTime: { type: 'string', description: 'Start date/time in ISO format' },
            resourceIds: { type: 'array', items: { type: 'number' }, description: 'Resource IDs' },
            notes: { type: 'string', description: 'Appointment notes' },
            staffRequested: { type: 'boolean', description: 'Staff requested' },
            executePayment: { type: 'boolean', description: 'Deprecated and ignored: not part of the Mindbody API' },
            sendEmail: { type: 'boolean', description: 'Send confirmation email' },
            applyPayment: { type: 'boolean', description: 'Apply payment' },
          },
          required: ['clientId', 'staffId', 'locationId', 'sessionTypeId', 'startDateTime'],
        },
      },
      {
        name: 'updateAppointment',
        description:
          "Update ONE appointment belonging to ONE client: reschedule, change staff, notes or resources, or apply a " +
          `status action via execute (confirm, unconfirm, arrive, unarrive, complete). Guards, all checked before ` +
          `anything is written: clientId and appointmentId must both be given; the appointment must belong to that ` +
          `client, else "not found for this client"; a cancelled appointment is final and accepts no update; a ` +
          `completed or no-show one takes no status action, no payment and no reschedule (notes are still fine); ` +
          `execute complete needs the appointment to have started, in the site's timezone. applyPayment may not be ` +
          `combined with a reschedule. Does not cancel: use cancelAppointments.`,
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID who owns the appointment; verified before any write' },
            appointmentId: { type: 'number', description: 'Appointment ID' },
            staffId: { type: 'number', description: 'Staff ID' },
            startDateTime: { type: 'string', description: 'Start date/time' },
            endDateTime: { type: 'string', description: 'End date/time' },
            resourceIds: { type: 'array', items: { type: 'number' }, description: 'Resource IDs' },
            notes: { type: 'string', description: 'Notes' },
            execute: {
              type: 'string',
              enum: [...UPDATE_APPOINTMENT_EXECUTE_VALUES],
              description:
                'Status action to apply. Cancellation is not accepted here; use cancelAppointments. ' +
                'complete additionally requires the appointment to have started.',
            },
            executePayment: { type: 'boolean', description: 'Deprecated and ignored: not part of the Mindbody API' },
            sendEmail: { type: 'boolean', description: 'Send email' },
            applyPayment: {
              type: 'boolean',
              description:
                "Apply a current applicable client service from the client's account. Refused alongside a " +
                'reschedule, and on an appointment that has already taken place.',
            },
          },
          required: ['clientId', 'appointmentId'],
        },
      },
      {
        name: 'cancelAppointments',
        description:
          `Cancel future appointments for a single client. Guards, all checked before anything is cancelled: ` +
          `one client per call; 1-${MAX_CANCELLATIONS_PER_REQUEST} appointment IDs, no duplicates; ` +
          `each appointment must belong to that client, start in the future, and not already be ` +
          `cancelled, late-cancelled, completed or a no-show. All-or-nothing: if any ID fails a guard, ` +
          `none are cancelled. Cancellations run one at a time and stop at the first failure.`,
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID who owns every appointment' },
            appointmentIds: {
              type: 'array',
              items: { type: 'number' },
              description: `1-${MAX_CANCELLATIONS_PER_REQUEST} appointment IDs to cancel`,
            },
            lateCancel: { type: 'boolean', description: 'Record as late cancellations (default false)' },
            sendEmail: { type: 'boolean', description: 'Email the client about the cancellation (default false)' },
          },
          required: ['clientId', 'appointmentIds'],
        },
      },
      {
        name: 'getBookableItems',
        description: 'Get available appointment slots',
        inputSchema: {
          type: 'object',
          properties: {
            sessionTypeIds: { type: 'array', items: { type: 'number' }, description: 'Session type IDs' },
            locationIds: { type: 'array', items: { type: 'number' }, description: 'Location IDs' },
            staffIds: { type: 'array', items: { type: 'number' }, description: 'Staff IDs' },
            startDate: { type: 'string', description: 'Start date' },
            endDate: { type: 'string', description: 'End date' },
            appointmentId: { type: 'number', description: 'Appointment ID for rescheduling' },
          },
          required: ['sessionTypeIds'],
        },
      },
      {
        name: 'getActiveSessionTimes',
        description:
          'Get the active session start times (the business-hours increments at which sessions can be scheduled; not bookable availability, use getBookableItems for that). Returns activeTimes (all "HH:MM:SS" start times), bySessionType (sessionTypeId with its own activeTimes) and totalActiveTimes',
        inputSchema: {
          type: 'object',
          properties: {
            scheduleType: { type: 'string', enum: ['All', 'Class', 'Enrollment', 'Appointment'] },
            sessionTypeIds: { type: 'array', items: { type: 'number' }, description: 'Session type IDs' },
            startTime: { type: 'string', description: 'Start time' },
            endTime: { type: 'string', description: 'End time (HH:MM:SS)' },
          },
        },
      },
      {
        name: 'getScheduleItems',
        description: 'Get schedule items/availability',
        inputSchema: {
          type: 'object',
          properties: {
            locationIds: { type: 'array', items: { type: 'number' }, description: 'Location IDs' },
            staffIds: { type: 'array', items: { type: 'number' }, description: 'Staff IDs' },
            startDate: { type: 'string', description: 'Start date' },
            endDate: { type: 'string', description: 'End date' },
            ignorePrepFinishTimes: { type: 'boolean', description: 'Ignore appointment prep/finish times' },
          },
        },
      },
      
      // Enrollment Tools
      {
        name: 'getEnrollments',
        description: 'List enrollments (courses, workshops, series) scheduled at the site: GET /enrollment/enrollments. Each row is a ClassSchedule whose Program has ScheduleType Enrollment; its `id` is the classScheduleId that addClientToEnrollment takes. Without dates: today through 365 days ahead in the site timezone. Sessions (individual classes) are not included; use getClasses with classScheduleIds for them.',
        inputSchema: {
          type: 'object',
          properties: {
            locationIds: { type: 'array', items: { type: 'number' }, description: 'Location IDs' },
            classScheduleIds: { type: 'array', items: { type: 'number' }, description: 'Enrollment (class schedule) IDs' },
            staffIds: { type: 'array', items: { type: 'number' }, description: 'Staff IDs' },
            programIds: { type: 'array', items: { type: 'number' }, description: 'Program IDs (enrollment programs: getPrograms with scheduleType Enrollment)' },
            sessionTypeIds: { type: 'array', items: { type: 'number' }, description: 'Session type IDs' },
            startDate: { type: 'string', description: 'Start date (YYYY-MM-DD); default today at the site' },
            endDate: { type: 'string', description: 'End date (YYYY-MM-DD); default 365 days after startDate' },
          },
        },
      },
      {
        name: 'addClientToEnrollment',
        description: 'Book one client into one enrollment: POST /enrollment/addclienttoenrollment. With neither enrollDateForward nor enrollOpenDates the client is booked into the whole enrollment. enrollDateForward books every session from that date on (the enrollment must allow date-forward enrollment); enrollOpenDates books only the listed sessions (the enrollment must allow open enrollment). Refuses to book a session the client already holds (Mindbody itself allows double booking). Returns the schedule with its sessions. To move a client to other dates, cancel with cancelEnrollmentVisits and add again; Mindbody has no move operation.',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID' },
            classScheduleId: { type: 'number', description: 'Enrollment ID (the `id` from getEnrollments)' },
            enrollDateForward: { type: 'string', description: 'Enroll from this date on (YYYY-MM-DDTHH:mm:ss, site-local). Takes priority over enrollOpenDates' },
            enrollOpenDates: { type: 'array', items: { type: 'string' }, description: 'Enroll only for these session date-times (YYYY-MM-DDTHH:mm:ss, site-local)' },
            waitlist: { type: 'boolean', description: 'Add to the enrollment waitlist instead (default false)' },
            waitlistEntryId: { type: 'number', description: 'Move this waitlist entry into the enrollment' },
            sendEmail: { type: 'boolean', description: 'Email the client (default false)' },
            test: { type: 'boolean', description: 'Validate only; nothing is committed (default false)' },
          },
          required: ['clientId', 'classScheduleId'],
        },
      },
      {
        name: 'getClientEnrollments',
        description: 'A client\'s enrollments (courses, workshops, series) with every session they hold, grouped by enrollment. Reads the client schedule (GET /client/clientschedule, waitlist entries included) and resolves each visit\'s class (GET /class/classes); a visit counts as an enrollment session only when its class belongs to a Program with ScheduleType Enrollment, so drop-in classes and appointments are excluded. Each session carries the visitId that cancelEnrollmentVisits takes. Without dates: today through 365 days ahead in the site timezone, so past sessions appear only when startDate is given.',
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID' },
            startDate: { type: 'string', description: 'Start date (YYYY-MM-DD); default today at the site' },
            endDate: { type: 'string', description: 'End date (YYYY-MM-DD); default 365 days after startDate' },
          },
          required: ['clientId'],
        },
      },
      {
        name: 'cancelEnrollmentVisits',
        description: `Cancel 1 to ${MAX_ENROLLMENT_CANCELLATIONS_PER_REQUEST} future enrollment sessions for ONE client, by visit ID (from getClientEnrollments), via POST /class/removeclientfromclass. Before anything is written, every visit must be on the client's own schedule, be a booked enrollment session (not an appointment, waitlist entry or drop-in class), start in the future in the site timezone, and not be late-cancelled or signed in (Mindbody reports future unattended enrollment visits as missed, so that flag is not a guard). All-or-nothing: if any visit fails a guard nothing is cancelled and \`rejected\` says why. This is the only way to drop a client from an enrollment; to move them to other dates, cancel then addClientToEnrollment.`,
        inputSchema: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'Client ID who owns every visit' },
            visitIds: { type: 'array', items: { type: 'number' }, description: `1 to ${MAX_ENROLLMENT_CANCELLATIONS_PER_REQUEST} visit IDs, no duplicates` },
            lateCancel: { type: 'boolean', description: 'Record as late cancellations (default false)' },
            sendEmail: { type: 'boolean', description: 'Email the client (default false)' },
          },
          required: ['clientId', 'visitIds'],
        },
      },
    ],
  };
};

const callToolHandler = async (request: CallToolRequest): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // Teacher/Staff Tools
      case 'getTeacherSchedule':
        const teacherResult = await getTeacherScheduleTool(
          args.teacherName as string,
          args.startDate as string | undefined,
          args.endDate as string | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(teacherResult, null, 2) }] };
      
      case 'getStaff':
        const staffResult = await getStaffTool(
          args.staffIds as number[] | undefined,
          args.filters as string[] | undefined,
          args.sessionTypeId as number | undefined,
          args.locationId as number | undefined,
          args.startDateTime as string | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(staffResult, null, 2) }] };
      
      // Class Management Tools
      case 'getClasses':
        const classesResult = await getClassesTool(
          args.startDate as string | undefined,
          args.endDate as string | undefined,
          args.locationIds as number[] | undefined,
          args.classDescriptionIds as number[] | undefined,
          args.staffIds as number[] | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(classesResult, null, 2) }] };
      
      case 'getClassDescriptions':
        const descriptionsResult = await getClassDescriptionsTool();
        return { content: [{ type: 'text', text: JSON.stringify(descriptionsResult, null, 2) }] };
      
      case 'getClassSchedules':
        const schedulesResult = await getClassSchedulesTool(
          args.locationIds as number[] | undefined,
          args.classDescriptionIds as number[] | undefined,
          args.staffIds as number[] | undefined,
          args.programIds as number[] | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(schedulesResult, null, 2) }] };
      
      case 'addClientToClass':
        const addClassResult = await addClientToClassTool(
          args.clientId as string,
          args.classId as number,
          args.requirePayment as boolean | undefined,
          args.waitlist as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(addClassResult, null, 2) }] };
      
      case 'removeClientFromClass':
        const removeClassResult = await removeClientFromClassTool(
          args.clientId as string,
          args.classId as number,
          args.lateCancel as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(removeClassResult, null, 2) }] };
      
      case 'getWaitlistEntries':
        const waitlistResult = await getWaitlistEntriesTool(
          args.classScheduleIds as number[] | undefined,
          args.classIds as number[] | undefined,
          args.clientIds as string[] | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(waitlistResult, null, 2) }] };
      
      case 'substituteClassTeacher':
        const subResult = await substituteClassTeacherTool(
          args.classId as number,
          args.substituteTeacherId as number
        );
        return { content: [{ type: 'text', text: JSON.stringify(subResult, null, 2) }] };

      case 'getClassVisits':
        const classVisitsResult = await getClassVisitsTool(
          args.classId as number,
          args.lastModifiedDate as string | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(classVisitsResult, null, 2) }] };

      // Client Management Tools
      case 'getClients':
        const clientsResult = await getClientsTool(
          args.searchText as string | undefined,
          args.clientIds as string[] | undefined,
          args.lastModifiedDate as string | undefined,
          args.isProspect as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(clientsResult, null, 2) }] };
      
      case 'addClient':
        const addClientResult = await addClientTool(
          args.firstName as string,
          args.lastName as string,
          args.email as string | undefined,
          args.mobilePhone as string | undefined,
          args.birthDate as string | undefined,
          args.addressLine1 as string | undefined,
          args.city as string | undefined,
          args.state as string | undefined,
          args.postalCode as string | undefined,
          args.country as string | undefined,
          args.emergencyContactName as string | undefined,
          args.emergencyContactPhone as string | undefined,
          args.emergencyContactRelationship as string | undefined,
          args.sendAccountEmails as boolean | undefined,
          args.referredBy as string | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(addClientResult, null, 2) }] };
      
      case 'updateClient':
        const updateClientResult = await updateClientTool(
          args.clientId as string,
          args.updates as any
        );
        return { content: [{ type: 'text', text: JSON.stringify(updateClientResult, null, 2) }] };
      
      case 'getClientVisits':
        const visitsResult = await getClientVisitsTool(
          args.clientId as string,
          args.startDate as string | undefined,
          args.endDate as string | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(visitsResult, null, 2) }] };
      
      case 'getClientMemberships':
        const membershipsResult = await getClientMembershipsTool(
          args.clientId as string,
          args.locationId as number | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(membershipsResult, null, 2) }] };
      
      case 'addClientArrival':
        const arrivalResult = await addClientArrivalTool(
          args.clientId as string,
          args.locationId as number
        );
        return { content: [{ type: 'text', text: JSON.stringify(arrivalResult, null, 2) }] };
      
      case 'getClientAccountBalances':
        const balancesResult = await getClientAccountBalancesTool(args.clientId as string);
        return { content: [{ type: 'text', text: JSON.stringify(balancesResult, null, 2) }] };
      
      case 'getClientContracts':
        const contractsResult = await getClientContractsTool(args.clientId as string);
        return { content: [{ type: 'text', text: JSON.stringify(contractsResult, null, 2) }] };
      
      // Sales & Commerce Tools
      case 'getServices':
        const servicesResult = await getServicesTool(
          args.programIds as number[] | undefined,
          args.sessionTypeIds as number[] | undefined,
          args.locationId as number | undefined,
          args.classId as number | undefined,
          args.hideRelatedPrograms as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(servicesResult, null, 2) }] };
      
      case 'getPackages':
        const packagesResult = await getPackagesTool(
          args.locationId as number | undefined,
          args.packageIds as number[] | undefined,
          args.sellOnline as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(packagesResult, null, 2) }] };
      
      case 'getProducts':
        const productsResult = await getProductsTool(
          args.productIds as number[] | undefined,
          args.searchText as string | undefined,
          args.categoryIds as number[] | undefined,
          args.subCategoryIds as number[] | undefined,
          args.sellOnline as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(productsResult, null, 2) }] };
      
      case 'getContracts':
        const getContractsResult = await getContractsTool(
          args.locationId as number,
          args.contractIds as number[] | undefined,
          args.soldOnline as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(getContractsResult, null, 2) }] };
      
      case 'checkoutShoppingCart':
        const checkoutResult = await checkoutShoppingCartTool(
          args.clientId as string,
          args.items as any,
          args.payments as any,
          args.inStore as boolean | undefined,
          args.promotionCode as string | undefined,
          args.sendEmail as boolean | undefined,
          args.locationId as number | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(checkoutResult, null, 2) }] };
      
      case 'purchaseContract':
        const purchaseResult = await purchaseContractTool(
          args.clientId as string,
          args.contractId as number,
          args.startDate as string,
          args.firstPaymentOccurs as any,
          args.clientSignature as string | undefined,
          args.promotionCode as string | undefined,
          args.locationId as number | undefined,
          args.useAccountCredit as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(purchaseResult, null, 2) }] };
      
      // Site & Location Tools
      case 'getSites':
        const sitesResult = await getSitesTool(args.siteId as string | undefined);
        return { content: [{ type: 'text', text: JSON.stringify(sitesResult, null, 2) }] };
      
      case 'getLocations':
        const locationsResult = await getLocationsTool();
        return { content: [{ type: 'text', text: JSON.stringify(locationsResult, null, 2) }] };
      
      case 'getPrograms':
        const programsResult = await getProgramsTool(
          args.scheduleType as any,
          args.onlineOnly as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(programsResult, null, 2) }] };
      
      case 'getResources':
        const resourcesResult = await getResourcesTool(
          args.locationIds as number[] | undefined,
          args.programIds as number[] | undefined,
          args.resourceIds as number[] | undefined,
          args.scheduleTypes as string[] | undefined,
          args.includeInactive as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(resourcesResult, null, 2) }] };
      
      case 'getSessionTypes':
        const sessionTypesResult = await getSessionTypesTool(
          args.programIds as number[] | undefined,
          args.onlineOnly as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(sessionTypesResult, null, 2) }] };
      
      case 'getActivationCode':
        const activationResult = await getActivationCodeTool();
        return { content: [{ type: 'text', text: JSON.stringify(activationResult, null, 2) }] };
      
      // Appointment Tools
      case 'getStaffAppointments':
        const appointmentsResult = await getStaffAppointmentsTool(
          args.staffIds as number[],
          args.locationIds as number[] | undefined,
          args.startDate as string | undefined,
          args.endDate as string | undefined,
          args.appointmentIds as number[] | undefined,
          args.clientId as string | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(appointmentsResult, null, 2) }] };
      
      case 'addAppointment':
        const addAppointmentResult = await addAppointmentTool(
          args.clientId as string,
          args.staffId as number,
          args.locationId as number,
          args.sessionTypeId as number,
          args.startDateTime as string,
          args.resourceIds as number[] | undefined,
          args.notes as string | undefined,
          args.staffRequested as boolean | undefined,
          args.executePayment as boolean | undefined,
          args.sendEmail as boolean | undefined,
          args.applyPayment as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(addAppointmentResult, null, 2) }] };
      
      case 'updateAppointment':
        const updateAppointmentResult = await updateAppointmentTool(
          args.clientId as string,
          args.appointmentId as number,
          args.staffId as number | undefined,
          args.startDateTime as string | undefined,
          args.endDateTime as string | undefined,
          args.resourceIds as number[] | undefined,
          args.notes as string | undefined,
          args.executePayment as boolean | undefined,
          args.sendEmail as boolean | undefined,
          args.applyPayment as boolean | undefined,
          args.execute as UpdateAppointmentExecute | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(updateAppointmentResult, null, 2) }] };

      case 'cancelAppointments':
        const cancelAppointmentsResult = await cancelAppointmentsTool(
          args.clientId as string,
          args.appointmentIds as number[],
          args.lateCancel as boolean | undefined,
          args.sendEmail as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(cancelAppointmentsResult, null, 2) }] };
      
      case 'getBookableItems':
        const bookableResult = await getBookableItemsTool(
          args.sessionTypeIds as number[],
          args.locationIds as number[] | undefined,
          args.staffIds as number[] | undefined,
          args.startDate as string | undefined,
          args.endDate as string | undefined,
          args.appointmentId as number | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(bookableResult, null, 2) }] };
      
      case 'getActiveSessionTimes':
        const activeTimesResult = await getActiveSessionTimesTool(
          args.scheduleType as any,
          args.sessionTypeIds as number[] | undefined,
          args.startTime as string | undefined,
          args.endTime as string | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(activeTimesResult, null, 2) }] };
      
      case 'getScheduleItems':
        const scheduleItemsResult = await getScheduleItemsTool(
          args.locationIds as number[] | undefined,
          args.staffIds as number[] | undefined,
          args.startDate as string | undefined,
          args.endDate as string | undefined,
          args.ignorePrepFinishTimes as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(scheduleItemsResult, null, 2) }] };
      
      // Enrollment Tools
      case 'getEnrollments':
        const enrollmentsResult = await getEnrollmentsTool(
          args.locationIds as number[] | undefined,
          args.classScheduleIds as number[] | undefined,
          args.staffIds as number[] | undefined,
          args.programIds as number[] | undefined,
          args.sessionTypeIds as number[] | undefined,
          args.startDate as string | undefined,
          args.endDate as string | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(enrollmentsResult, null, 2) }] };

      case 'addClientToEnrollment':
        const addEnrollmentResult = await addClientToEnrollmentTool(
          args.clientId as string,
          args.classScheduleId as number,
          args.enrollDateForward as string | undefined,
          args.enrollOpenDates as string[] | undefined,
          args.waitlist as boolean | undefined,
          args.sendEmail as boolean | undefined,
          args.test as boolean | undefined,
          args.waitlistEntryId as number | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(addEnrollmentResult, null, 2) }] };

      case 'getClientEnrollments':
        const clientEnrollmentsResult = await getClientEnrollmentsTool(
          args.clientId as string,
          args.startDate as string | undefined,
          args.endDate as string | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(clientEnrollmentsResult, null, 2) }] };

      case 'cancelEnrollmentVisits':
        const cancelEnrollmentResult = await cancelEnrollmentVisitsTool(
          args.clientId as string,
          args.visitIds as number[],
          args.lateCancel as boolean | undefined,
          args.sendEmail as boolean | undefined
        );
        return { content: [{ type: 'text', text: JSON.stringify(cancelEnrollmentResult, null, 2) }] };
      
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
};

/**
 * Build a new MCP Server with all tool handlers registered.
 *
 * MUST be called once per connection/transport. A single shared Server instance
 * lets concurrent SSE clients observe each other's session state - see advisory
 * GHSA-345p-7cg4-v4c7.
 */
function createMcpServer(): Server {
  const server = new Server(
    {
      name: process.env.MCP_SERVER_NAME || 'mindbody-mcp',
      version: process.env.MCP_SERVER_VERSION || '2.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, callToolHandler);

  return server;
}

// Parse command-line arguments
function parseArgs(): { transport: 'stdio' | 'sse', port?: number, host?: string, sslCert?: string, sslKey?: string } {
  const args = process.argv.slice(2);
  let transport: 'stdio' | 'sse' = 'stdio';
  let port: number | undefined;
  let host: string | undefined;
  let sslCert: string | undefined;
  let sslKey: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--transport' || arg === '-t') {
      const value = args[++i];
      if (value === 'sse' || value === 'stdio') {
        transport = value;
      }
    } else if (arg === '--port' || arg === '-p') {
      port = parseInt(args[++i], 10);
    } else if (arg === '--host') {
      // -h is help, not host: see isHelpRequested().
      host = args[++i];
    } else if (arg === '--ssl-cert') {
      sslCert = args[++i];
    } else if (arg === '--ssl-key') {
      sslKey = args[++i];
    }
  }

  // Check environment variables as fallback
  if (!transport && process.env.MCP_TRANSPORT) {
    transport = process.env.MCP_TRANSPORT.toLowerCase() as 'stdio' | 'sse';
  }
  if (!port && process.env.MCP_PORT) {
    port = parseInt(process.env.MCP_PORT, 10);
  }
  if (!host && process.env.MCP_HOST) {
    host = process.env.MCP_HOST;
  }
  if (!sslCert && process.env.MCP_SSL_CERT) {
    sslCert = process.env.MCP_SSL_CERT;
  }
  if (!sslKey && process.env.MCP_SSL_KEY) {
    sslKey = process.env.MCP_SSL_KEY;
  }

  return { transport, port, host, sslCert, sslKey };
}

// Hosts that are always safe for local development. Note these are compared as
// full `Host` header values, so they are listed with and without the default
// port because the SDK does an exact string match on the header.
const LOCAL_DEV_HOSTS = [
  'localhost',
  'localhost:3000',
  '127.0.0.1',
  '127.0.0.1:3000',
  '[::1]',
  '[::1]:3000',
];

/**
 * Enforce DNS rebinding protection at the HTTP layer.
 *
 * This exists because the SDK's own `validateRequestHeaders()` is only reachable
 * from `SSEServerTransport.handlePostMessage()`, which this server never calls -
 * the POST route below only sets CORS headers. So setting the transport options
 * alone provides NO protection here. We validate the GET ourselves, which is the
 * request that actually opens the stream.
 *
 * Semantics deliberately mirror the SDK exactly (see validateRequestHeaders in
 * SDK 1.32.1): Host is compared by exact string match against the allowlist, and
 * Origin is only checked when an origin allowlist is configured.
 *
 * @returns an error string when the request must be rejected, else undefined.
 */
function checkDnsRebinding(
  req: http.IncomingMessage,
  settings: { enableDnsRebindingProtection: boolean; allowedHosts: string[]; allowedOrigins: string[] }
): string | undefined {
  if (!settings.enableDnsRebindingProtection) {
    return undefined;
  }

  if (settings.allowedHosts.length > 0) {
    const hostHeader = req.headers.host;
    if (!hostHeader || !settings.allowedHosts.includes(hostHeader)) {
      return `Invalid Host header: ${hostHeader}`;
    }
  }

  if (settings.allowedOrigins.length > 0) {
    const originHeader = req.headers.origin;
    if (originHeader && !settings.allowedOrigins.includes(originHeader)) {
      return `Invalid Origin header: ${originHeader}`;
    }
  }

  return undefined;
}

/**
 * Resolve DNS rebinding protection settings for the SSE transport.
 *
 * Security posture: protection is ON by default.
 *
 * Evidence from SDK 1.32.1 (`dist/esm/server/sse.js`, validateRequestHeaders):
 *   - if `enableDnsRebindingProtection` is falsy, validation is skipped entirely;
 *   - the Host header is only checked when `allowedHosts` is non-empty;
 *   - the Origin header is only checked when `allowedOrigins` is non-empty.
 *
 * So enabling protection with an empty allowlist is a no-op (it does not reject
 * everything), and enabling it with a localhost allowlist keeps local dev
 * working. We therefore default `allowedHosts` to loopback names rather than
 * leaving it undefined.
 */
function resolveDnsRebindingSettings(port: number): {
  enableDnsRebindingProtection: boolean;
  allowedHosts: string[];
  allowedOrigins: string[];
} {
  // Opt-out escape hatch. Anything other than an explicit falsy value keeps
  // protection enabled.
  const rawOptOut = process.env.MCP_DNS_REBINDING_PROTECTION?.trim().toLowerCase();
  const enabled = rawOptOut !== 'false' && rawOptOut !== '0' && rawOptOut !== 'no' && rawOptOut !== 'off';

  const parseList = (value: string | undefined): string[] | undefined => {
    const items = value
      ?.split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items && items.length > 0 ? items : undefined;
  };

  const configuredHosts = parseList(process.env.MCP_ALLOWED_HOSTS);

  // When the operator has not set an explicit allowlist, fall back to loopback
  // plus the port we are actually listening on, so a non-default MCP_PORT in
  // local development still works with zero configuration.
  const allowedHosts = configuredHosts ?? [
    ...LOCAL_DEV_HOSTS,
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
  ];

  return {
    enableDnsRebindingProtection: enabled,
    allowedHosts: enabled ? allowedHosts : [],
    // Origins are only checked when explicitly configured; the SSE endpoint is
    // normally driven by native MCP clients that send no Origin header at all.
    allowedOrigins: parseList(process.env.MCP_ALLOWED_ORIGINS) ?? [],
  };
}

// Start SSE server
async function startSSEServer(config: { port?: number, host?: string, sslCert?: string, sslKey?: string }) {
  const port = config.port || 3000;
  const host = config.host || '0.0.0.0';

  // DNS rebinding protection is enabled by default; see
  // resolveDnsRebindingSettings() for the SDK-derived rationale.
  const dnsRebinding = resolveDnsRebindingSettings(port);
  if (dnsRebinding.enableDnsRebindingProtection) {
    console.error(`DNS rebinding protection: ON (allowed hosts: ${dnsRebinding.allowedHosts.join(', ')})`);
    if (!process.env.MCP_ALLOWED_HOSTS && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      console.error(
        `WARNING: bound to ${host} but no MCP_ALLOWED_HOSTS set. ` +
        'Remote clients will be rejected until you set MCP_ALLOWED_HOSTS to your public hostname, ' +
        'or set MCP_DNS_REBINDING_PROTECTION=false to disable the check.'
      );
    }
  } else {
    console.error('DNS rebinding protection: DISABLED (MCP_DNS_REBINDING_PROTECTION opt-out set)');
  }

  // Every SSE connection gets its own Server instance so that concurrent
  // sessions cannot observe each other's state (GHSA-345p-7cg4-v4c7).
  const activeServers = new Set<Server>();
  
  // Create HTTP/HTTPS server based on SSL configuration
  let httpServer: http.Server | https.Server;
  
  if (config.sslCert && config.sslKey) {
    // HTTPS server for production
    try {
      const sslOptions = {
        cert: fs.readFileSync(config.sslCert),
        key: fs.readFileSync(config.sslKey),
      };
      httpServer = https.createServer(sslOptions);
      console.error(`Starting HTTPS SSE server on ${host}:${port}`);
    } catch (error) {
      console.error('Failed to load SSL certificates:', error);
      console.error('Falling back to HTTP server');
      httpServer = http.createServer();
    }
  } else {
    // HTTP server for development
    httpServer = http.createServer();
    console.error(`Starting HTTP SSE server on ${host}:${port}`);
  }

  // Handle HTTP requests
  httpServer.on('request', async (req, res) => {
    // Set CORS headers for all requests
    const corsOrigin = process.env.MCP_CORS_ORIGIN || '*';
    
    // Handle OPTIONS preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-ID',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      return;
    }
    
    // Health check endpoint
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin
      });
      res.end(JSON.stringify({ 
        status: 'healthy',
        server: 'mindbody-mcp',
        version: process.env.MCP_SERVER_VERSION || '2.0.0',
        transport: 'sse',
        timestamp: new Date().toISOString()
      }));
      return;
    }
    
    // Server info endpoint
    if (req.url === '/info' && req.method === 'GET') {
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin
      });
      res.end(JSON.stringify({
        name: process.env.MCP_SERVER_NAME || 'mindbody-mcp',
        version: process.env.MCP_SERVER_VERSION || '2.0.0',
        description: 'Comprehensive MCP server for Mindbody API',
        capabilities: {
          tools: true,
          resources: false,
          prompts: false
        },
        transport: {
          type: 'sse',
          endpoint: '/sse',
          cors: true
        }
      }));
      return;
    }
    
    // SSE endpoint - create transport for each connection
    if (req.url === '/sse' && req.method === 'GET') {
      // DNS rebinding protection. Must run before any header is written,
      // otherwise the response is already committed and we cannot send a 403.
      const rebindingError = checkDnsRebinding(req, dnsRebinding);
      if (rebindingError) {
        console.error(`Rejected SSE connection: ${rebindingError}`);
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(rebindingError);
        return;
      }

      // Set SSE headers.
      // These must be set via setHeader (not writeHead) because the SDK's
      // SSEServerTransport.start() issues its own res.writeHead(200, ...) when
      // connect() runs. Calling writeHead here first throws
      // ERR_HTTP_HEADERS_SENT and kills the SSE endpoint. setHeader values are
      // merged into that writeHead, with the SDK's own Content-Type winning.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-ID');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering

      // Create SSE transport for this connection
      const transport = new SSEServerTransport('/sse', res as any, {
        // DNS rebinding protection - ON by default, env-driven.
        enableDnsRebindingProtection: dnsRebinding.enableDnsRebindingProtection,
        allowedHosts: dnsRebinding.allowedHosts,
        allowedOrigins: dnsRebinding.allowedOrigins,
      });

      // Give this connection its own Server with its own tool handlers.
      const connectionServer = createMcpServer();
      activeServers.add(connectionServer);

      // Connect the server to this transport
      await connectionServer.connect(transport);

      // Handle connection close
      req.on('close', () => {
        activeServers.delete(connectionServer);
        transport.close();
      });
      
      return;
    }
    
    // Handle POST requests to SSE endpoint (for sending messages back)
    if (req.url === '/sse' && req.method === 'POST') {
      // This will be handled by the SSE transport
      // Just pass through with CORS headers
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-ID');
      return;
    }
    
    // 404 for other paths
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });
  
  // Start the HTTP server
  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, host, () => {
      console.error(`Mindbody MCP Server v2.0 (SSE) listening on ${host}:${port}`);
      console.error(`Health check: http${config.sslCert ? 's' : ''}://${host}:${port}/health`);
      console.error(`SSE endpoint: http${config.sslCert ? 's' : ''}://${host}:${port}/sse`);
      resolve();
    });
    httpServer.on('error', reject);
  });
  
  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    console.error(`\nShutting down SSE server gracefully (${signal})...`);
    for (const active of activeServers) {
      try {
        await active.close();
      } catch {
        // Connection already torn down; nothing to do.
      }
    }
    activeServers.clear();
    httpServer.close(() => {
      console.error('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

// Start STDIO server
async function startStdioServer() {
  // STDIO is a single-client transport, so one Server instance is correct here.
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Mindbody MCP Server v2.0 started (STDIO) - Complete yoga studio management');
}

// Main entry point
async function main() {
  const config = parseArgs();
  
  console.error('Starting Mindbody MCP Server v2.0');
  console.error(`Transport: ${config.transport.toUpperCase()}`);
  
  if (config.transport === 'sse') {
    await startSSEServer(config);
  } else {
    await startStdioServer();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});