import { createHash } from 'crypto';
import { mkdir, rename, writeFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import type { NinjaOneAPI } from './ninja-api.js';
import { getDevicesComplete, getTicketsComplete } from './complete-queries.js';
import { arrayFromResponse, collectPages } from './pagination.js';

export const AUDIT_TEMPLATES = [
  'device_activity',
  'organization_activity',
  'device_inventory',
  'patch_reboot',
  'ticket_device',
] as const;

export type AuditTemplate = typeof AUDIT_TEMPLATES[number];

type AuditArguments = {
  template: AuditTemplate;
  deviceId?: number | undefined;
  organizationId?: number | undefined;
  ticketId?: number | undefined;
  boardId?: number | undefined;
  startTime?: string | undefined;
  endTime?: string | undefined;
  searchTerms?: string[] | undefined;
  format?: 'txt' | 'json' | undefined;
  outputName?: string | undefined;
  maxPages?: number | undefined;
  maxItems?: number | undefined;
};

function epoch(value: string | undefined, label: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid ISO timestamp`);
  return parsed / 1000;
}

function requireNumber(value: number | undefined, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${name} is required and must be a positive integer`);
  }
  return Number(value);
}

export function sanitizeOutputName(value: string): string {
  const name = basename(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return name || 'ninjaone-audit';
}

function activityRows(value: unknown): Array<Record<string, unknown>> {
  return arrayFromResponse(value, ['activities', 'results'])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
}

function activityTime(item: Record<string, unknown>): number {
  return Number(item.activityTime);
}

function activityId(item: Record<string, unknown>): number | null {
  const id = Number(item.id);
  return Number.isFinite(id) ? id : null;
}

function filterWindow(
  rows: Array<Record<string, unknown>>,
  start: number | null,
  end: number | null,
): Array<Record<string, unknown>> {
  return rows.filter((row) => {
    const time = activityTime(row);
    if (!Number.isFinite(time)) return false;
    if (start !== null && time < start) return false;
    if (end !== null && time > end) return false;
    return true;
  });
}

async function collectActivities(
  fetchPage: (olderThan?: number) => Promise<unknown>,
  start: number | null,
  maxPages?: number,
  maxItems?: number,
) {
  return collectPages<Record<string, unknown>, number>({
    maxPages,
    maxItems,
    fetchPage: async (cursor) => {
      const rows = activityRows(await fetchPage(cursor));
      const ids = rows.map(activityId).filter((id): id is number => id !== null);
      const nextCursor = ids.length > 0 ? Math.min(...ids) : undefined;
      const crossedStart = start !== null && rows.some((row) => activityTime(row) < start);
      return {
        items: rows,
        nextCursor,
        hasMore: rows.length === 1000 && !crossedStart,
      };
    },
  });
}

function searchMatches(value: unknown[], terms: string[]) {
  const normalized = terms.map((term) => term.toLowerCase()).filter(Boolean);
  return value.filter((item) => {
    const text = JSON.stringify(item).toLowerCase();
    return normalized.some((term) => text.includes(term));
  });
}

function safeForExport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeForExport);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(authorization|access_?token|refresh_?token|client_?secret|secret)$/i.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = safeForExport(child);
    }
  }
  return output;
}

function defaultTerms(template: AuditTemplate): string[] {
  return template === 'patch_reboot'
    ? ['patch', 'reboot', 'restart', 'upgrade', 'automation', 'script', 'task', 'action']
    : [];
}

async function buildAudit(api: NinjaOneAPI, args: AuditArguments) {
  const start = epoch(args.startTime, 'startTime');
  const end = epoch(args.endTime, 'endTime');
  if (start !== null && end !== null && start > end) {
    throw new Error('startTime must be before endTime');
  }
  const terms = args.searchTerms?.length ? args.searchTerms : defaultTerms(args.template);

  switch (args.template) {
    case 'device_activity': {
      const deviceId = requireNumber(args.deviceId, 'deviceId');
      const [device, paged] = await Promise.all([
        api.getDevice(deviceId),
        collectActivities(
          (olderThan) => api.getDeviceActivities(
            deviceId,
            1000,
            olderThan === undefined ? undefined : String(olderThan),
          ),
          start,
          args.maxPages,
          args.maxItems,
        ),
      ]);
      const activities = filterWindow(paged.items, start, end);
      return {
        target: { deviceId },
        device,
        pagination: {
          pages: paged.pages,
          scanned: paged.scanned,
          complete: paged.complete,
          hasMore: paged.hasMore,
          nextCursor: paged.nextCursor,
          stoppedReason: paged.stoppedReason,
        },
        activities,
        matches: searchMatches(activities, terms),
      };
    }
    case 'organization_activity': {
      const organizationId = requireNumber(args.organizationId, 'organizationId');
      const [organization, devices, paged] = await Promise.all([
        api.getOrganization(organizationId),
        getDevicesComplete(api, {
          organizationId,
          maxPages: args.maxPages,
          maxItems: args.maxItems,
        }),
        collectActivities(
          (olderThan) => api.getActivities(
            olderThan === undefined
              ? { pageSize: 1000 }
              : { pageSize: 1000, olderThan },
          ),
          start,
          args.maxPages,
          args.maxItems,
        ),
      ]);
      const ids = new Set(
        devices.results
          .map((item) => Number((item as Record<string, unknown>).id))
          .filter(Number.isFinite),
      );
      const window = filterWindow(paged.items, start, end);
      const activities = window.filter((activity) => ids.has(Number(activity.deviceId)));
      return {
        target: { organizationId },
        organization,
        devices: {
          scanned: devices.scanned,
          complete: devices.complete,
          results: devices.results,
        },
        pagination: {
          pages: paged.pages,
          scanned: paged.scanned,
          complete: paged.complete && devices.complete,
          activityComplete: paged.complete,
          deviceMapComplete: devices.complete,
          hasMore: paged.hasMore,
          nextCursor: paged.nextCursor,
          stoppedReason: paged.stoppedReason,
        },
        activities,
        matches: searchMatches(activities, terms),
      };
    }
    case 'device_inventory': {
      const organizationId = requireNumber(args.organizationId, 'organizationId');
      const [organization, devices] = await Promise.all([
        api.getOrganization(organizationId),
        getDevicesComplete(api, {
          organizationId,
          maxPages: args.maxPages,
          maxItems: args.maxItems,
        }),
      ]);
      return {
        target: { organizationId },
        organization,
        pagination: {
          pages: devices.pages,
          scanned: devices.scanned,
          complete: devices.complete,
          hasMore: devices.hasMore,
          nextCursor: devices.nextCursor,
          stoppedReason: devices.stoppedReason,
        },
        devices: devices.results,
        matches: searchMatches(devices.results, terms),
      };
    }
    case 'patch_reboot': {
      const deviceId = requireNumber(args.deviceId, 'deviceId');
      const [device, paged, deviceJobs, activeJobs, scheduledTasks, automations, osPatches, softwarePatches] =
        await Promise.all([
          api.getDevice(deviceId),
          collectActivities(
            (olderThan) => api.getDeviceActivities(
              deviceId,
              1000,
              olderThan === undefined ? undefined : String(olderThan),
            ),
            start,
            args.maxPages,
            args.maxItems,
          ),
          api.getDeviceActiveJobs(deviceId),
          api.getActiveJobs(),
          api.getScheduledTasks(),
          api.getAutomations(),
          api.getDeviceOSPatchInstalls(deviceId),
          api.getDeviceSoftwarePatchInstalls(deviceId),
        ]);
      const activities = filterWindow(paged.items, start, end);
      const searchable = [
        ...activities,
        ...arrayFromResponse(deviceJobs, ['jobs']),
        ...arrayFromResponse(activeJobs, ['jobs']),
        ...arrayFromResponse(scheduledTasks, ['tasks']),
        ...arrayFromResponse(osPatches, ['results']),
        ...arrayFromResponse(softwarePatches, ['results']),
        automations,
      ];
      return {
        target: { deviceId },
        device,
        pagination: {
          pages: paged.pages,
          scanned: paged.scanned,
          complete: paged.complete,
          hasMore: paged.hasMore,
          nextCursor: paged.nextCursor,
          stoppedReason: paged.stoppedReason,
        },
        activities,
        deviceJobs,
        activeJobs,
        scheduledTasks,
        automations,
        osPatchInstalls: osPatches,
        softwarePatchInstalls: softwarePatches,
        matches: searchMatches(searchable, terms),
      };
    }
    case 'ticket_device': {
      const ticketId = requireNumber(args.ticketId, 'ticketId');
      const [ticket, ticketLog] = await Promise.all([
        api.getTicket(ticketId),
        api.getTicketLog(ticketId),
      ]);
      const ticketRecord = ticket && typeof ticket === 'object'
        ? ticket as Record<string, unknown>
        : {};
      const deviceIdValue = Number(ticketRecord.nodeId ?? ticketRecord.deviceId);
      const device = Number.isFinite(deviceIdValue) && deviceIdValue > 0
        ? await api.getDevice(deviceIdValue)
        : null;
      const boardScan = args.boardId !== undefined
        ? await getTicketsComplete(api, {
            boardId: args.boardId,
            deviceId: Number.isFinite(deviceIdValue) ? deviceIdValue : undefined,
            maxPages: args.maxPages,
            maxItems: args.maxItems,
          })
        : null;
      const searchable = [ticket, ticketLog, device, boardScan].filter(Boolean);
      return {
        target: { ticketId, boardId: args.boardId ?? null },
        ticket,
        ticketLog,
        device,
        boardScan,
        matches: searchMatches(searchable, terms),
      };
    }
  }
}

export async function exportReadonlyAudit(api: NinjaOneAPI, args: AuditArguments) {
  if (!AUDIT_TEMPLATES.includes(args.template)) {
    throw new Error(`Unsupported audit template: ${args.template}`);
  }
  const generatedAt = new Date().toISOString();
  const payload = safeForExport({
    metadata: {
      operation: 'READ ONLY',
      template: args.template,
      generatedAt,
      timezone: 'America/Los_Angeles',
      startTime: args.startTime || null,
      endTime: args.endTime || null,
      searchTerms: args.searchTerms?.length ? args.searchTerms : defaultTerms(args.template),
      note: 'No NinjaOne state was modified.',
    },
    audit: await buildAudit(api, args),
  });

  const format = args.format === 'json' ? 'json' : 'txt';
  const timestamp = generatedAt.replace(/[:.]/g, '-');
  const stem = sanitizeOutputName(args.outputName || `${args.template}-${timestamp}`);
  const exportRoot = resolve(process.env.NINJA_EXPORT_DIR || join(process.cwd(), 'exports'));
  const outputPath = resolve(exportRoot, `${stem}.${format}`);
  if (dirname(outputPath) !== exportRoot) {
    throw new Error('Audit output must remain inside the configured export directory');
  }

  await mkdir(exportRoot, { recursive: true });
  const json = JSON.stringify(payload, null, 2);
  const content = format === 'json'
    ? `${json}\n`
    : `NinjaOne Read-Only Audit\n========================\n\n${json}\n`;
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, outputPath);

  return {
    operation: 'READ ONLY',
    template: args.template,
    outputPath,
    format,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: createHash('sha256').update(content).digest('hex'),
    generatedAt,
    complete: Boolean(
      payload &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>).audit &&
      typeof (payload as Record<string, unknown>).audit === 'object' &&
      (((payload as Record<string, unknown>).audit as Record<string, unknown>).pagination as
        Record<string, unknown> | undefined)?.complete !== false
    ),
  };
}
