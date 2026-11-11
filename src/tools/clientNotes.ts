import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { ClientFormulaNote } from '../types/mindbody.js';

/**
 * A client's formula notes (`GET /client/clientformulanotes`), read-only.
 *
 * The API has no site-wide listing: a call is scoped to a client, an
 * appointment, or both, and at least one is required. Notes are cross-regional,
 * so `clientId` on each note is the client's ID at the site the note came from
 * and can differ from the requested `clientId`. Staff names are filled only for
 * notes tied to an appointment.
 */
export async function getClientFormulaNotesTool(
  clientId?: string,
  appointmentId?: number,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  formulaNotes: Array<{
    id: number;
    clientId?: string;
    appointmentId?: number;
    entryDate?: string;
    note?: string;
    siteId?: number;
    siteName?: string;
    staffName?: string;
  }>;
  totalFormulaNotes: number;
}> {
  if (!clientId && appointmentId === undefined) {
    throw new Error('getClientFormulaNotes needs a clientId, an appointmentId, or both');
  }

  const { items } = await fetchAllPages<ClientFormulaNote>(
    client,
    '/client/clientformulanotes',
    { ClientId: clientId, AppointmentId: appointmentId },
    'FormulaNotes'
  );

  const formulaNotes = items.map((n) => ({
    id: n.Id,
    clientId: n.ClientId,
    appointmentId: n.AppointmentId,
    entryDate: n.EntryDate,
    note: n.Note,
    siteId: n.SiteId,
    siteName: n.SiteName,
    staffName:
      n.StaffDisplayName ||
      [n.StaffFirstName, n.StaffLastName].filter(Boolean).join(' ') ||
      undefined,
  }));

  return { formulaNotes, totalFormulaNotes: formulaNotes.length };
}
