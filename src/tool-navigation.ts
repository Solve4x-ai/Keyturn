import type { AuthProfile } from './security-profile.js';

type Domain = {
  description: string;
  tools: string[];
};

const DOMAINS: Record<string, Domain> = {
  devices: {
    description: 'Device lookup, inventory, activity, health, and approved device commands.',
    tools: [
      'get_devices', 'get_devices_complete', 'get_device', 'search_devices_by_name',
      'resolve_devices', 'get_device_activities', 'get_device_software',
      'reboot_device', 'set_device_maintenance',
    ],
  },
  organizations: {
    description: 'Organizations, locations, policies, and organization-scoped device inventory.',
    tools: [
      'get_organizations', 'get_organization', 'get_organization_locations',
      'get_organization_policies', 'get_devices_complete',
      'resolve_organizations', 'resolve_locations', 'resolve_policies',
    ],
  },
  workspace: {
    description: 'Local entity cache, sync, change history, saved filters, journal, and session scope.',
    tools: [
      'sync_entities', 'get_entity_changes', 'get_operation_journal',
      'save_filter', 'list_saved_filters', 'delete_saved_filter',
      'set_context', 'get_context',
    ],
  },
  activities: {
    description: 'Device and system activity research plus durable read-only audit exports.',
    tools: ['get_device_activities', 'get_activities', 'export_readonly_audit'],
  },
  tickets: {
    description: 'Ticket boards, complete ticket scans, ticket detail, logs, and guarded writes.',
    tools: [
      'get_ticket_boards', 'get_ticket_statuses', 'get_tickets', 'get_tickets_complete',
      'get_ticket', 'get_ticket_log', 'create_ticket', 'update_ticket', 'add_ticket_comment',
    ],
  },
  alerts: {
    description: 'Alert discovery, device alerts, and guarded alert reset.',
    tools: ['get_alerts', 'get_alert', 'get_device_alerts', 'reset_alert'],
  },
  inventory: {
    description: 'Hardware, operating-system, software, service, and custom-field inventory.',
    tools: [
      'query_computer_systems', 'query_operating_systems', 'query_processors',
      'query_disks', 'query_volumes', 'query_network_interfaces', 'query_software',
      'query_windows_services', 'query_custom_fields', 'export_readonly_audit',
    ],
  },
  patches: {
    description: 'Read-only patch posture and disabled-by-default deployment operations.',
    tools: [
      'query_os_patches', 'query_software_patches', 'query_os_patch_installs',
      'query_software_patch_installs', 'get_devices_pending_patches',
      'scan_device_os_patches', 'apply_device_os_patches',
    ],
  },
  security: {
    description: 'Authentication profile, policy, endpoint discovery, and security inventory.',
    tools: [
      'get_auth_profile', 'find_endpoint', 'describe_endpoint', 'query_antivirus_status',
      'query_antivirus_threats', 'get_policy', 'get_device_policy_overrides',
    ],
  },
};

export function navigateTools(
  domain: string | undefined,
  profile: AuthProfile,
  exposedToolNames: string[],
) {
  const exposed = new Set(exposedToolNames);
  if (!domain) {
    return {
      profile,
      stateful: false,
      uiRequired: false,
      domains: Object.entries(DOMAINS).map(([name, definition]) => ({
        name,
        description: definition.description,
        availableToolCount: definition.tools.filter((tool) => exposed.has(tool)).length,
      })),
      note: 'Pass a domain name to see currently available tools. Navigation does not change permissions.',
    };
  }

  const selected = DOMAINS[domain.toLowerCase()];
  if (!selected) {
    return {
      profile,
      error: `Unknown domain: ${domain}`,
      validDomains: Object.keys(DOMAINS),
    };
  }

  const tools = selected.tools.filter((tool) => exposed.has(tool));
  return {
    domain: domain.toLowerCase(),
    profile,
    description: selected.description,
    stateful: false,
    uiRequired: false,
    tools,
    note: 'Only tools already allowed by the active security profile are shown.',
  };
}

