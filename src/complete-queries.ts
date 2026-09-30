import type { NinjaOneAPI } from './ninja-api.js';
import { arrayFromResponse, collectPages } from './pagination.js';

function numericId(item: unknown): number | null {
  if (!item || typeof item !== 'object') return null;
  const id = Number((item as Record<string, unknown>).id);
  return Number.isFinite(id) ? id : null;
}

function maxId(items: unknown[]): number | undefined {
  const ids = items.map(numericId).filter((id): id is number => id !== null);
  return ids.length > 0 ? Math.max(...ids) : undefined;
}

export async function getDevicesComplete(
  api: NinjaOneAPI,
  args: {
    organizationId?: number | undefined;
    df?: string | undefined;
    pageSize?: number | undefined;
    maxPages?: number | undefined;
    maxItems?: number | undefined;
  },
) {
  const pageSize = Math.min(Math.max(Math.trunc(args.pageSize || 200), 1), 1000);
  const result = await collectPages<unknown, number>({
    maxPages: args.maxPages,
    maxItems: args.maxItems,
    fetchPage: async (cursor) => {
      const response = args.organizationId !== undefined
        ? await api.getOrganizationDevices(args.organizationId, pageSize, cursor)
        : await api.getDevices(args.df, pageSize, cursor);
      const items = arrayFromResponse(response, ['devices', 'results']);
      const nextCursor = maxId(items);
      return {
        items,
        nextCursor,
        hasMore: items.length === pageSize,
      };
    },
  });

  return {
    organizationId: args.organizationId ?? null,
    filter: args.df || null,
    pageSize,
    pages: result.pages,
    scanned: result.scanned,
    matched: result.items.length,
    complete: result.complete,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
    stoppedReason: result.stoppedReason,
    results: result.items,
    note: args.organizationId !== undefined
      ? 'Organization scoping used the dedicated organization devices endpoint.'
      : 'General device endpoint used. Supply organizationId for path-enforced organization scoping.',
  };
}

function normalize(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function ticketMatches(
  ticket: Record<string, unknown>,
  status?: string,
  organizationId?: number,
  deviceId?: number,
): boolean {
  if (status !== undefined) {
    const rawStatus = ticket.status;
    const label = typeof rawStatus === 'string'
      ? rawStatus
      : rawStatus && typeof rawStatus === 'object'
        ? String((rawStatus as Record<string, unknown>).displayName ??
            (rawStatus as Record<string, unknown>).name ?? '')
        : '';
    if (normalize(label) !== normalize(status)) return false;
  }
  if (organizationId !== undefined) {
    const actual = Number(ticket.clientId ?? ticket.organizationId);
    if (actual !== organizationId) return false;
  }
  if (deviceId !== undefined) {
    const actual = Number(ticket.nodeId ?? ticket.deviceId);
    if (actual !== deviceId) return false;
  }
  return true;
}

function ticketRows(response: unknown): Array<Record<string, unknown>> {
  return arrayFromResponse(response, ['tickets', 'results', 'data'])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
}

function ticketCursor(response: unknown, rows: Array<Record<string, unknown>>): number | undefined {
  if (response && typeof response === 'object') {
    const metadata = (response as Record<string, unknown>).metadata;
    if (metadata && typeof metadata === 'object') {
      const cursor = Number((metadata as Record<string, unknown>).lastCursorId);
      if (Number.isFinite(cursor) && cursor > 0) return cursor;
    }
  }
  return maxId(rows);
}

export async function getTicketsComplete(
  api: NinjaOneAPI,
  args: {
    boardId: number;
    status?: string | undefined;
    organizationId?: number | undefined;
    deviceId?: number | undefined;
    pageSize?: number | undefined;
    maxPages?: number | undefined;
    maxItems?: number | undefined;
  },
) {
  const pageSize = Math.min(Math.max(Math.trunc(args.pageSize || 100), 1), 1000);
  const result = await collectPages<Record<string, unknown>, number>({
    maxPages: args.maxPages,
    maxItems: args.maxItems,
    fetchPage: async (cursor) => {
      const response = await api.getTickets(args.boardId, pageSize, cursor);
      const rows = ticketRows(response);
      return {
        items: rows,
        nextCursor: ticketCursor(response, rows),
        hasMore: rows.length === pageSize,
      };
    },
  });

  const matches = result.items.filter((ticket) =>
    ticketMatches(ticket, args.status, args.organizationId, args.deviceId),
  );
  return {
    boardId: args.boardId,
    filters: {
      status: args.status || null,
      organizationId: args.organizationId ?? null,
      deviceId: args.deviceId ?? null,
    },
    filtersApplied: 'client-side after each complete board page',
    pageSize,
    pages: result.pages,
    scanned: result.scanned,
    matched: matches.length,
    complete: result.complete,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
    stoppedReason: result.stoppedReason,
    results: matches,
    note: 'Board ID is explicit. A result is complete only when complete=true.',
  };
}
