/**
 * Organization boundary — extracted verbatim from index.ts dispatch so the
 * authorization check around write tools is unit-testable (M0). Behavior is
 * intentionally unchanged.
 *
 * KNOWN GAP (recorded in docs/m0-gap-assessment.md, deferred to M4):
 * `deviceRecord` reuses the resolver's cached record when available, so a
 * stale cached org membership can authorize a write without a fresh
 * upstream read (invariant 6 / commandcenter.md §5.5).
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  WRITE_TOOLS,
  DEVICE_TARGET_WRITE_TOOLS,
  ORGANIZATION_TARGET_WRITE_ARGUMENTS,
} from './security-profile.js';
import type { ResolvedEntity } from './entity-resolver.js';

export interface BoundaryResolved {
  device?: ResolvedEntity;
  devices?: ResolvedEntity[];
}

export function readOrganizationId(value: any): number | null {
  const candidates = [
    value?.organizationId,
    value?.orgId,
    value?.org_id,
    value?.clientId,
    value?.organization?.id,
    value?.client?.id,
  ];
  return candidates.find((candidate) => typeof candidate === 'number') ?? null;
}

export function assertAllowedOrganization(allowedOrganizationIds: number[], organizationId: number | null, action: string): void {
  if (allowedOrganizationIds.length === 0) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Command policy has no verified allowed organization IDs; "${action}" is blocked`,
    );
  }
  if (organizationId === null || !allowedOrganizationIds.includes(organizationId)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `"${action}" is outside the command profile's allowed organization boundary`,
    );
  }
}

export async function enforceOrganizationBoundary(
  api: { getDevice(id: number): Promise<any>; getTicket(id: number): Promise<any>; getAlert(uid: string): Promise<any> },
  profile: string,
  allowedOrganizationIds: number[],
  name: string,
  args: any,
  resolved: BoundaryResolved = {},
): Promise<void> {
  if (profile !== 'command' || !WRITE_TOOLS.has(name)) return;

  const deviceRecord = async (deviceId: number, r?: ResolvedEntity) =>
    r && r.id === deviceId && Object.keys(r.record).length > 0
      ? r.record
      : await api.getDevice(deviceId);

  if (name === 'create_ticket') {
    assertAllowedOrganization(
      allowedOrganizationIds,
      typeof args.clientId === 'number' ? args.clientId : null,
      name,
    );
    return;
  }
  if (name === 'update_ticket' || name === 'add_ticket_comment') {
    const ticket = await api.getTicket(args.ticketId);
    assertAllowedOrganization(allowedOrganizationIds, readOrganizationId(ticket), name);
    return;
  }
  if (DEVICE_TARGET_WRITE_TOOLS.has(name)) {
    const deviceId = typeof args.deviceId === 'number' ? args.deviceId : args.id;
    const device = await deviceRecord(deviceId, resolved.device);
    assertAllowedOrganization(allowedOrganizationIds, readOrganizationId(device), name);
    return;
  }
  if (name === 'approve_devices') {
    if (!Array.isArray(args.deviceIds) || args.deviceIds.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'approve_devices requires explicit device IDs');
    }
    for (let i = 0; i < args.deviceIds.length; i++) {
      const device = await deviceRecord(args.deviceIds[i], resolved.devices?.[i]);
      assertAllowedOrganization(allowedOrganizationIds, readOrganizationId(device), name);
    }
    return;
  }
  if (name === 'reset_alert') {
    const alert = await api.getAlert(args.uid);
    const deviceId = alert?.deviceId;
    if (typeof deviceId !== 'number') {
      throw new McpError(ErrorCode.InvalidRequest, 'Unable to resolve the alert device organization');
    }
    const device = await api.getDevice(deviceId);
    assertAllowedOrganization(allowedOrganizationIds, readOrganizationId(device), name);
    return;
  }
  const organizationArgument = ORGANIZATION_TARGET_WRITE_ARGUMENTS[name];
  if (organizationArgument) {
    assertAllowedOrganization(
      allowedOrganizationIds,
      typeof args[organizationArgument] === 'number' ? args[organizationArgument] : null,
      name,
    );
  }
}
