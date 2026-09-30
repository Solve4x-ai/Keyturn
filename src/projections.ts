/**
 * Slim response projections — cut tokens by returning the handful of fields
 * models actually need. `detail: 'full'` on a tool keeps the raw payload.
 */

/**
 * Model-egress allowlists (invariant 11) — the only fields the summary
 * projection may emit per entity type. Exported for audit/tests; the
 * summarize functions below must not emit keys outside these sets.
 */
export const DEVICE_EGRESS = [
  'id', 'systemName', 'displayName', 'dnsName', 'organizationId', 'organizationName',
  'locationId', 'nodeClass', 'offline', 'lastContact',
] as const;
export const ORGANIZATION_EGRESS = ['id', 'name', 'description'] as const;
export const TICKET_EGRESS = [
  'id', 'boardId', 'subject', 'status', 'priority', 'severity',
  'organizationId', 'deviceId', 'created', 'updated',
] as const;
export const ALERT_EGRESS = [
  'uid', 'deviceId', 'severity', 'priority', 'sourceType', 'subject', 'activityTime', 'reset',
] as const;
export const LOCATION_EGRESS = ['id', 'organizationId', 'name'] as const;

const pick = (obj: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
};

export function summarizeDevice(d: Record<string, unknown>, orgName?: string | null): Record<string, unknown> {
  const row = pick(d, [
    'id', 'device_id', 'systemName', 'system_name', 'displayName', 'display_name',
    'dnsName', 'dns_name', 'organizationId', 'org_id', 'locationId', 'location_id',
    'nodeClass', 'node_class', 'offline', 'lastContact', 'last_contact',
  ]);
  const out: Record<string, unknown> = {
    id: row.id ?? row.device_id,
    systemName: row.systemName ?? row.system_name,
    displayName: row.displayName ?? row.display_name,
    dnsName: row.dnsName ?? row.dns_name,
    organizationId: row.organizationId ?? row.org_id,
    locationId: row.locationId ?? row.location_id,
    nodeClass: row.nodeClass ?? row.node_class,
    offline: row.offline === 0 ? false : row.offline === 1 ? true : row.offline,
    lastContact: row.lastContact ?? row.last_contact,
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  const resolvedOrg = orgName ?? null;
  if (resolvedOrg !== null) out.organizationName = resolvedOrg;
  return out;
}

export function summarizeOrganization(o: Record<string, unknown>): Record<string, unknown> {
  return {
    id: o.id ?? o.org_id,
    name: o.name,
    description: o.description,
  };
}

export function summarizeTicket(t: Record<string, unknown>): Record<string, unknown> {
  const status = t.status;
  return {
    id: t.id,
    boardId: t.boardId ?? t.board_id,
    subject: t.subject ?? t.title ?? t.summary,
    status: typeof status === 'object' && status !== null
      ? ((status as Record<string, unknown>).displayName ?? (status as Record<string, unknown>).name)
      : status,
    priority: t.priority,
    severity: t.severity,
    organizationId: t.clientId ?? t.organizationId,
    deviceId: t.nodeId ?? t.deviceId,
    created: t.created ?? t.createTime ?? t.createdAt,
    updated: t.updated ?? t.lastUpdated ?? t.updatedAt,
  };
}

export function summarizeAlert(a: Record<string, unknown>): Record<string, unknown> {
  return {
    uid: a.uid,
    deviceId: a.deviceId,
    severity: a.severity,
    priority: a.priority,
    sourceType: a.sourceType,
    subject: a.subject ?? a.message,
    activityTime: a.activityTime ?? a.created,
    reset: a.reset,
  };
}

export function summarizeLocation(l: Record<string, unknown>): Record<string, unknown> {
  return {
    id: l.id ?? l.location_id,
    organizationId: l.organizationId ?? l.org_id,
    name: l.name,
  };
}
