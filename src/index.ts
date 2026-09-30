/**
 * Solve4x NinjaOne MCP server.
 * Local stdio transport with profile-based capability controls.
 * MCP SDK v1.30.0 compatible.
 */
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { NinjaOneAPI } from './ninja-api.js';
import type { MaintenanceUnit, MaintenanceWindowSelection } from './ninja-api.js';
import { EndpointCatalog } from './endpoint-discovery.js';
import { exportReadonlyAudit } from './audit-export.js';
import { getDevicesComplete, getTicketsComplete } from './complete-queries.js';
import { navigateTools } from './tool-navigation.js';
import {
  TICKET_WRITE_TOOLS,
  WRITE_TOOLS,
  filterTools,
  isToolAllowed,
  loadRuntimeSecurity,
  requiresApprovalPipeline,
  toolRequiresGenericConfirmation,
} from './security-profile.js';
import type { RuntimeSecurity } from './security-profile.js';
import { config } from 'dotenv';
import { createHash, randomUUID } from 'crypto';
import { resolveConnection } from './connections.js';
import { enforceOrganizationBoundary } from './org-boundary.js';
import { EntityStore, PERSIST_ALLOWLISTS } from './entity-store.js';
import { SnapshotService } from './snapshots.js';
import { OperationService, planApprovalRequired, OpError } from './operations.js';
import { SelectionService } from './selections.js';
import { buildOperationsReport, buildOrgReport, renderOrgReportMarkdown, renderReportMarkdown, resolveWindow } from './reports.js';
import { InfraService } from './infra.js';
import { listRunbooks, getRunbook, summarizeRunbook, RunbookError } from './runbooks.js';
import { ReviewService } from './review.js';
import { EntityResolver } from './entity-resolver.js';
import type { ResolvedEntity } from './entity-resolver.js';
import { summarizeAlert, summarizeDevice, summarizeOrganization, summarizeTicket } from './projections.js';

config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const MAINTENANCE_UNIT_SECONDS: Record<MaintenanceUnit, number> = {
  MINUTES: 60,
  HOURS: 60 * 60,
  DAYS: 24 * 60 * 60,
  WEEKS: 7 * 24 * 60 * 60
};

/**
 * Params that accept an entity name OR a numeric ID. Names are resolved
 * server-side before dispatch — ambiguous names fail with a candidate list.
 * Numeric strings are treated as IDs.
 */
const DEVICE_ID_PARAMS: Record<string, string[]> = {
  get_device: ['id'],
  get_device_dashboard_url: ['id'],
  get_device_software: ['id'],
  get_device_activities: ['id'],
  get_device_alerts: ['id'],
  get_device_policy_overrides: ['id'],
  reset_device_policy_overrides: ['id'],
  reboot_device: ['id'],
  set_device_maintenance: ['id'],
  update_device: ['id'],
  control_windows_service: ['id'],
  configure_windows_service: ['id'],
  scan_device_os_patches: ['id'],
  apply_device_os_patches: ['id'],
  scan_device_software_patches: ['id'],
  apply_device_software_patches: ['id'],
  get_device_scripting_options: ['deviceId'],
  run_device_script: ['deviceId'],
  run_device_powershell: ['deviceId'],
  get_powershell_result: ['deviceId'],
  create_plan: ['deviceId'],
  get_script_result: ['deviceId'],
  assign_device_policy: ['deviceId'],
  update_device_custom_fields: ['deviceId'],
  get_tickets_complete: ['deviceId'],
  create_ticket: ['nodeId'],
  update_ticket: ['nodeId'],
  approve_devices: ['deviceIds'], // array
};

const ORG_ID_PARAMS: Record<string, string[]> = {
  get_organization: ['id'],
  get_organization_locations: ['id'],
  get_organization_policies: ['id'],
  update_organization: ['id'],
  get_devices_complete: ['organizationId'],
  select_devices: ['orgId'],
  generate_report: ['orgId'],
  get_tickets_complete: ['organizationId'],
  generate_organization_installer: ['organizationId'],
  create_location: ['organizationId'],
  update_location: ['organizationId'],
  create_end_user: ['organizationId'],
  create_contact: ['organizationId'],
  update_org_custom_fields: ['orgId'],
  create_ticket: ['clientId'],
};

const POLICY_ID_PARAMS: Record<string, string[]> = {
  get_policy: ['policyId'],
  assign_device_policy: ['policyId'],
};

/** List tools that accept detail:"summary"|"full" (summary is the default). */
const DETAIL_TOOLS = new Set([
  'get_devices',
  'get_devices_complete',
  'get_organizations',
  'get_tickets',
  'get_tickets_complete',
  'get_alerts',
]);

/** Tools that accept a saved-filter name via the `filter` param. */
const FILTERABLE_TOOLS = new Set(['get_devices', 'get_devices_complete', 'resolve_devices']);

type ResolvedArgs = {
  device?: ResolvedEntity;
  devices?: ResolvedEntity[];
  organization?: ResolvedEntity;
  policy?: ResolvedEntity;
};

/**
 * Fixed tool definitions - removed complex filtering, kept all functionality
 */
const TOOLS = [
  {
    name: 'get_auth_profile',
    description: 'Show the active NinjaOne authentication profile and granted scopes without exposing credentials or tokens',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'find_endpoint',
    description: 'Search the pinned NinjaOne OpenAPI specification. Discovery only; this tool cannot execute API calls.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words from the endpoint path, operation, summary, or description' },
        category: { type: 'string', description: 'Optional exact OpenAPI tag/category' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'Optional HTTP method filter' },
        limit: { type: 'number', description: 'Maximum matches, 1-50 (default 20)' }
      }
    }
  },
  {
    name: 'describe_endpoint',
    description: 'Describe one endpoint from the pinned NinjaOne OpenAPI specification. Description only; no execution.',
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: 'Exact METHOD /path value returned by find_endpoint' }
      },
      required: ['endpoint']
    }
  },
  {
    name: 'ninjaone_navigate',
    description: 'List safe NinjaOne tool domains or show tools currently available in one domain. No UI or state change.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          enum: ['devices', 'organizations', 'activities', 'tickets', 'alerts', 'inventory', 'patches', 'security', 'workspace'],
          description: 'Optional tool domain'
        }
      }
    }
  },
  // Device Management Tools
  {
    name: 'get_devices',
    description: 'List all devices with basic filtering. Use simple filters only.',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' },
        after: { type: 'number', description: 'Pagination cursor' },
        df: { type: 'string', description: 'Simple device filter (e.g., "offline = true")' }
      }
    }
  },
  {
    name: 'get_devices_complete',
    description: 'Retrieve every device page with explicit completeness metadata. Prefer organizationId for path-enforced organization scoping.',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: { type: 'number', description: 'Optional organization ID; uses the dedicated organization devices endpoint' },
        df: { type: 'string', description: 'Optional general device filter when organizationId is omitted' },
        pageSize: { type: 'number', description: 'Page size, 1-1000 (default 200)' },
        maxPages: { type: 'number', description: 'Safety limit, 1-500 (default 50)' },
        maxItems: { type: 'number', description: 'Safety limit for total returned items (default 100000)' }
      }
    }
  },
  {
    name: 'list_regions',
    description: 'List supported NinjaONE regions and base URLs',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_region',
    description: 'Set region or base URL for API requests',
    inputSchema: {
      type: 'object',
      properties: {
        region: { type: 'string', description: 'Region key (us, us2, eu, ca, oc)' },
        baseUrl: { type: 'string', description: 'Custom base URL (overrides region if provided)' }
      }
    }
  },
  {
    name: 'get_device',
    description: 'Get detailed information about a specific device',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'reboot_device',
    description: 'Reboot a device with normal or forced mode. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' },
        mode: { type: 'string', enum: ['NORMAL', 'FORCED'], description: 'Reboot mode (default: NORMAL)' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['id']
    }
  },
  {
    name: 'set_device_maintenance',
    description: 'Set maintenance mode for a device. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' },
        mode: { type: 'string', enum: ['ON', 'OFF'], description: 'Maintenance mode' },
        duration: {
          type: 'object',
          description: 'Duration details when enabling maintenance mode',
          properties: {
            permanent: {
              type: 'boolean',
              description: 'Set true for permanent maintenance mode'
            },
            value: {
              type: 'number',
              description: 'Length of the maintenance window (required when not permanent)'
            },
            unit: {
              type: 'string',
              enum: ['MINUTES', 'HOURS', 'DAYS', 'WEEKS'],
              description: 'Time unit for the maintenance window (required when not permanent)'
            }
          }
        },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['id', 'mode']
    }
  },
  {
    name: 'get_organizations',
    description: 'List all organizations with pagination',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number', description: 'Number of results per page' },
        after: { type: 'number', description: 'Pagination cursor' }
      }
    }
  },
  {
    name: 'get_alerts',
    description: 'Get system alerts with basic filtering',
    inputSchema: {
      type: 'object',
      properties: {
        sourceType: { type: 'string', description: 'Alert source type filter' },
        since: { type: 'string', description: 'ISO timestamp — return alerts created after this time' },
        df: { type: 'string', description: 'Device filter (e.g., "org = 1")' }
      }
    }
  },
  {
    name: 'get_device_activities',
    description: 'Get activities for a specific device',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' },
        pageSize: { type: 'number', description: 'Number of results per page' }
      },
      required: ['id']
    }
  },
  /**
   * Get installed software inventory for a specific device.
   * Returns the list of installed applications including version, publisher,
   * and install date metadata for asset and compliance tracking.
   * Useful for: software asset management, compliance audits, security assessments.
   */
  {
    name: 'get_device_software',
    description: 'Get installed software for a specific device',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'get_device_dashboard_url',
    description: 'Get the dashboard URL for a specific device',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'search_devices_by_name',
    description: 'Search devices by system name (client-side filtering)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'System name to search for' },
        limit: { type: 'number', description: 'Maximum results to return (default: 10)' }
      },
      required: ['name']
    }
  },
  {
    name: 'find_windows11_devices',
    description: 'Find all Windows 11 devices (client-side filtering)',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum results to return (default: 20)' }
      }
    }
  },

  // Device Control
  {
    name: 'control_windows_service',
    description: 'Control a Windows service on a device',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' },
        serviceId: { type: 'string', description: 'Service ID' },
        action: { type: 'string', description: 'Action to perform (e.g., START, STOP, RESTART)' }
      },
      required: ['id', 'serviceId', 'action']
    }
  },
  {
    name: 'configure_windows_service',
    description: 'Configure a Windows service startup type on a device',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' },
        serviceId: { type: 'string', description: 'Service ID' },
        startupType: { type: 'string', description: 'Startup type (e.g., AUTOMATIC, MANUAL, DISABLED)' }
      },
      required: ['id', 'serviceId', 'startupType']
    }
  },
  // Device Patching
  {
    name: 'scan_device_os_patches',
    description: 'Scan for OS patches on a device',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'apply_device_os_patches',
    description: 'Apply OS patches on a device. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' },
        patches: { type: 'array', items: { type: 'object' }, description: 'List of OS patches to apply' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['id', 'patches']
    }
  },
  {
    name: 'scan_device_software_patches',
    description: 'Scan for software patches on a device',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'apply_device_software_patches',
    description: 'Apply software patches on a device. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' },
        patches: { type: 'array', items: { type: 'object' }, description: 'List of software patches to apply' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['id', 'patches']
    }
  },

  // Organizations - details
  {
    name: 'get_organization',
    description: 'Get organization details by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Organization ID' } },
      required: ['id']
    }
  },
  {
    name: 'get_organization_locations',
    description: 'Get locations for an organization',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Organization ID' } },
      required: ['id']
    }
  },
  {
    name: 'get_organization_policies',
    description: 'Get policies for an organization',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Organization ID' } },
      required: ['id']
    }
  },
  {
    name: 'generate_organization_installer',
    description: 'Generate installer for an organization/location',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: { type: 'number', description: 'Organization ID' },
        locationId: { type: 'number', description: 'Location ID' },
        installerType: { type: 'string', description: 'Installer type (e.g., WINDOWS_MSI, MAC_DMG, MAC_PKG, LINUX_DEB, LINUX_RPM)' }
      },
      required: ['organizationId', 'locationId', 'installerType']
    }
  },
  // Organization CRUD
  // Delete operations are intentionally omitted because the public API
  // does not expose organization or location removal endpoints.
  {
    name: 'create_organization',
    description: 'Create a new organization',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Organization name' },
        description: { type: 'string', description: 'Organization description' },
        nodeApprovalMode: {
          type: 'string',
          description: 'Device approval mode (AUTOMATIC, MANUAL, REJECT)',
          enum: ['AUTOMATIC', 'MANUAL', 'REJECT']
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_organization',
    description: 'Update an organization (node approval mode is read-only after creation)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Organization ID' },
        name: { type: 'string', description: 'Organization name' },
        description: { type: 'string', description: 'Organization description' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' }
      },
      required: ['id']
    }
  },

  // Location CRUD
  {
    name: 'create_location',
    description: 'Create a new location for an organization',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: { type: 'number', description: 'Organization ID' },
        name: { type: 'string', description: 'Location name' },
        address: { type: 'string', description: 'Location address' },
        description: { type: 'string', description: 'Location description' }
      },
      required: ['organizationId', 'name']
    }
  },
  {
    name: 'update_location',
    description: 'Update a location',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: { type: 'number', description: 'Organization ID' },
        locationId: { type: 'number', description: 'Location ID' },
        name: { type: 'string', description: 'Location name' },
        address: { type: 'string', description: 'Location address' },
        description: { type: 'string', description: 'Location description' }
      },
      required: ['organizationId', 'locationId']
    }
  },

  // Alerts - details
  {
    name: 'get_alert',
    description: 'Get a specific alert by UID',
    inputSchema: {
      type: 'object',
      properties: { uid: { type: 'string', description: 'Alert UID' } },
      required: ['uid']
    }
  },
  {
    name: 'reset_alert',
    description: 'Reset/acknowledge an alert by UID. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Alert UID' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['uid']
    }
  },
  {
    name: 'get_device_alerts',
    description: 'Get alerts for a specific device',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Device ID' }, lang: { type: 'string', description: 'Language code' } },
      required: ['id']
    }
  },

  // Users & Roles
  {
    name: 'get_end_users',
    description: 'List end users',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_end_user',
    description: 'Get an end user by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }
  },
  {
    name: 'create_end_user',
    description: 'Create a new end user',
    inputSchema: {
      type: 'object',
      properties: {
        firstName: { type: 'string', description: 'First name of the end user' },
        lastName: { type: 'string', description: 'Last name of the end user' },
        email: { type: 'string', description: 'Email address of the end user' },
        phone: { type: 'string', description: 'Phone number of the end user' },
        organizationId: { type: 'number', description: 'Organization identifier' },
        fullPortalAccess: { type: 'boolean', description: 'Grant full portal access' },
        sendInvitation: { type: 'boolean', description: 'Send an invitation email to the end user' }
      },
      required: ['firstName', 'lastName', 'email']
    }
  },
  {
    name: 'update_end_user',
    description: 'Update an end user (Note: phone field cannot be changed after creation)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'End user ID' },
        firstName: { type: 'string', description: 'First name' },
        lastName: { type: 'string', description: 'Last name' },
        email: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone number (read-only after creation)' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_end_user',
    description: 'Delete an end user by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'End user identifier' } },
      required: ['id']
    }
  },
  {
    name: 'get_technicians',
    description: 'List technicians',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_technician',
    description: 'Get a technician by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }
  },
  {
    name: 'add_role_members',
    description: 'Add users to a role',
    inputSchema: { type: 'object', properties: { roleId: { type: 'number' }, userIds: { type: 'array', items: { type: 'number' } } }, required: ['roleId', 'userIds'] }
  },
  {
    name: 'remove_role_members',
    description: 'Remove users from a role',
    inputSchema: { type: 'object', properties: { roleId: { type: 'number' }, userIds: { type: 'array', items: { type: 'number' } } }, required: ['roleId', 'userIds'] }
  },

  // Contacts
  {
    name: 'get_contacts',
    description: 'List contacts',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_contact',
    description: 'Get a contact by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }
  },
  {
    name: 'create_contact',
    description: 'Create a contact',
    inputSchema: {
      type: 'object',
      properties: {
        organizationId: { type: 'number' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        jobTitle: { type: 'string' }
      },
      required: ['organizationId', 'firstName', 'lastName', 'email']
    }
  },
  {
    name: 'update_contact',
    description: 'Update a contact',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        jobTitle: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_contact',
    description: 'Delete a contact',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }
  },

  // Device approvals and policy
  {
    name: 'approve_devices',
    description: 'Approve or reject multiple devices. Set confirm=true to execute; default is dry-run.',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['APPROVE', 'REJECT'], description: 'APPROVE or REJECT' }, deviceIds: { type: 'array', items: { type: 'number' } }, confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' } }, required: ['mode', 'deviceIds'] }
  },
  {
    name: 'get_device_policy_overrides',
    description: 'Get policy overrides for a device',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] }
  },
  {
    name: 'reset_device_policy_overrides',
    description: 'Reset/remove all policy overrides for a device. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['id']
    }
  },
  {
    name: 'get_policies',
    description: 'List policies (optionally templates only)',
    inputSchema: {
      type: 'object',
      properties: {
        templateOnly: { type: 'boolean', description: 'If true, return only policy templates' }
      }
    }
  },

  // System Information Query Tools
  {
    name: 'query_antivirus_status',
    description: 'Query antivirus status information across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_antivirus_threats',
    description: 'Query antivirus threat detections across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_computer_systems',
    description: 'Query computer system information across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_device_health',
    description: 'Query device health status information',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_operating_systems',
    description: 'Query operating system information across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_logged_on_users',
    description: 'Query currently logged on users across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },

  // Hardware Query Tools
  {
    name: 'query_processors',
    description: 'Query processor information across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_disks',
    description: 'Query disk drive information across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_volumes',
    description: 'Query disk volume information across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_network_interfaces',
    description: 'Query network interface information across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_raid_controllers',
    description: 'Query RAID controller information across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_raid_drives',
    description: 'Query RAID drive information across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },

  // Software and Patch Query Tools
  {
    name: 'query_software',
    description: 'Query installed software across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_os_patches',
    description: 'Query operating system patches across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_software_patches',
    description: 'Query software patches across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_os_patch_installs',
    description: 'Query OS patch installation history across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_software_patch_installs',
    description: 'Query software patch installation history across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_windows_services',
    description: 'Query Windows services across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },

  // Custom Fields and Policy Query Tools
  {
    name: 'query_custom_fields',
    description: 'Query custom field values across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_custom_fields_detailed',
    description: 'Query detailed custom field information across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_scoped_custom_fields',
    description: 'Query scoped custom field values across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_scoped_custom_fields_detailed',
    description: 'Query detailed scoped custom field information across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },
  {
    name: 'query_policy_overrides',
    description: 'Query policy override information across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },

  // Backup Query Tools
  {
    name: 'query_backup_usage',
    description: 'Query backup usage statistics across devices',
    inputSchema: {
      type: 'object',
      properties: {
        df: { type: 'string', description: 'Device filter' },
        cursor: { type: 'string', description: 'Pagination cursor' },
        pageSize: { type: 'number', description: 'Number of results per page (default: 50)' }
      }
    }
  },

  // Auto-paginating search tools
  {
    name: 'search_software',
    description: 'Search installed software across all devices by name. Auto-paginates and filters server-side — much faster than manually iterating query_software.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Software name to search for (case-insensitive partial match)' },
        df: { type: 'string', description: 'Device filter (e.g., "org = 1")' },
        maxResults: { type: 'number', description: 'Maximum results to return (default: 50)' }
      },
      required: ['name']
    }
  },
  {
    name: 'search_os_patches',
    description: 'Search OS patches across all devices by name. Auto-paginates and filters server-side.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Patch name/KB to search for (case-insensitive partial match)' },
        df: { type: 'string', description: 'Device filter' },
        maxResults: { type: 'number', description: 'Maximum results to return (default: 50)' }
      },
      required: ['name']
    }
  },
  {
    name: 'search_windows_services',
    description: 'Search Windows services across all devices by name. Auto-paginates and filters server-side.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Service name to search for (case-insensitive partial match)' },
        df: { type: 'string', description: 'Device filter' },
        maxResults: { type: 'number', description: 'Maximum results to return (default: 50)' }
      },
      required: ['name']
    }
  },

  // Phase 2 — Write operations with confirmation guardrails

  {
    name: 'update_device',
    description: 'Update a device display name or user-defined fields. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Device ID' },
        displayName: { type: 'string', description: 'New display name' },
        userData: { type: 'object', description: 'Key-value pairs of user-defined fields' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['id']
    }
  },
  {
    name: 'update_device_custom_fields',
    description: 'Write custom field values on a device. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'number', description: 'Device ID' },
        fields: { type: 'object', description: 'Key-value pairs of custom fields to set' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['deviceId', 'fields']
    }
  },
  {
    name: 'update_org_custom_fields',
    description: 'Write custom field values on an organization. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        orgId: { type: 'number', description: 'Organization ID' },
        fields: { type: 'object', description: 'Key-value pairs of custom fields to set' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['orgId', 'fields']
    }
  },

  // Ticketing
  {
    name: 'get_ticket_boards',
    description: 'List all ticket boards',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_ticket_statuses',
    description: 'List all ticket status values configured in NinjaOne (parent + sub-statuses). Use before update_ticket to find valid status names.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_tickets',
    description: 'List tickets from a board with pagination',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'number', description: 'Ticket board ID' },
        pageSize: { type: 'number', description: 'Results per page (default: 25)' },
        lastCursorId: { type: 'number', description: 'Pagination cursor (last cursor ID from previous response)' }
      },
      required: ['boardId']
    }
  },
  {
    name: 'get_tickets_complete',
    description: 'Scan every page of an explicit ticket board, then apply status, organization, or device filters locally with completeness metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: { type: 'number', description: 'Explicit ticket board ID; never guessed' },
        status: { type: 'string', description: 'Optional status display-name filter' },
        organizationId: { type: 'number', description: 'Optional organization/client ID filter' },
        deviceId: { type: 'number', description: 'Optional device/node ID filter' },
        pageSize: { type: 'number', description: 'Page size, 1-1000 (default 100)' },
        maxPages: { type: 'number', description: 'Safety limit, 1-500 (default 50)' },
        maxItems: { type: 'number', description: 'Safety limit for total scanned tickets (default 100000)' }
      },
      required: ['boardId']
    }
  },
  {
    name: 'get_ticket',
    description: 'Get full detail for a single ticket',
    inputSchema: {
      type: 'object',
      properties: { ticketId: { type: 'number', description: 'Ticket ID' } },
      required: ['ticketId']
    }
  },
  {
    name: 'get_ticket_log',
    description: 'Get activity log for a ticket',
    inputSchema: {
      type: 'object',
      properties: { ticketId: { type: 'number', description: 'Ticket ID' } },
      required: ['ticketId']
    }
  },
  {
    name: 'create_ticket',
    description: 'Create a new ticket. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        clientId: { type: 'number', description: 'Organization (client) ID' },
        ticketFormId: { type: 'number', description: 'Ticket form ID (default: 1)' },
        summary: { type: 'string', description: 'Ticket summary (max 200 chars)' },
        description: { type: 'string', description: 'Ticket description body text' },
        status: { type: 'string', enum: ['NEW', 'OPEN', 'WAITING', 'PAUSED', 'RESOLVED', 'CLOSED'], description: 'Ticket status (default: NEW)' },
        priority: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'], description: 'Priority' },
        severity: { type: 'string', enum: ['NONE', 'MINOR', 'MODERATE', 'MAJOR', 'CRITICAL'], description: 'Severity' },
        type: { type: 'string', enum: ['PROBLEM', 'QUESTION', 'INCIDENT', 'TASK', 'CHANGE_REQUEST', 'SERVICE_REQUEST', 'PROJECT', 'APPOINTMENT', 'MISCELLANEOUS'], description: 'Ticket type' },
        nodeId: { type: 'number', description: 'Associated device (node) ID' },
        assignedAppUserId: { type: 'number', description: 'Assigned technician user ID' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['summary']
    }
  },
  {
    name: 'update_ticket',
    description: 'Update an existing ticket. Fetches current state automatically — only specify fields you want to change. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'number', description: 'Ticket ID' },
        summary: { type: 'string', description: 'Ticket subject/summary (max 200 chars)' },
        status: { type: 'string', description: 'Status name (e.g. NEW, OPEN, WAITING, PAUSED, RESOLVED, CLOSED, APPROVED, REJECTED — or tenant-specific sub-statuses like "Awaiting Response"). Fetch full catalog via get_ticket_statuses.' },
        priority: { type: 'string', enum: ['NONE', 'LOW', 'MEDIUM', 'HIGH'], description: 'Priority' },
        severity: { type: 'string', enum: ['NONE', 'MINOR', 'MODERATE', 'MAJOR', 'CRITICAL'], description: 'Severity' },
        type: { type: 'string', enum: ['PROBLEM', 'QUESTION', 'INCIDENT', 'TASK', 'CHANGE_REQUEST', 'SERVICE_REQUEST', 'PROJECT', 'APPOINTMENT', 'MISCELLANEOUS'], description: 'Ticket type' },
        assignedAppUserId: { type: 'number', description: 'Assigned technician user ID' },
        locationId: { type: 'number', description: 'Organization location ID' },
        nodeId: { type: 'number', description: 'Associated device (node) ID' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Complete ticket tag list' },
        comment: { type: 'string', description: 'Optional comment to add with the update' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['ticketId']
    }
  },
  {
    name: 'add_ticket_comment',
    description: 'Add a comment/note to a ticket via POST /v2/ticketing/ticket/{id}/comment. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'number', description: 'Ticket ID' },
        comment: { type: 'string', description: 'Comment text' },
        public: { type: 'boolean', description: 'Whether the comment is visible to end users (default true)' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['ticketId', 'comment']
    }
  },

  // Phase 3 — Webhooks & event-driven

  {
    name: 'get_webhook_config',
    description: 'Show the current NinjaOne webhook configuration',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_webhook_config',
    description: 'Configure a webhook endpoint for NinjaOne events. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Webhook URL to receive events' },
        activities: { type: 'object', description: 'Map of activity categories to event type arrays (e.g., {"DEVICE": ["ADDED", "DELETED"]})' },
        expand: { type: 'array', items: { type: 'string' }, description: 'Activity types to include expanded data for' },
        headers: {
          type: 'array',
          description: 'Custom HTTP headers (array of {name, value} objects) — use for auth/secrets',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' }
            },
            required: ['name', 'value']
          }
        },
        organizationIds: { type: 'array', items: { type: 'number' }, description: 'Limit webhook to specific organization IDs (optional)' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['url']
    }
  },
  {
    name: 'delete_webhook_config',
    description: 'Remove the webhook configuration. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      }
    }
  },
  {
    name: 'get_stale_devices',
    description: 'List devices that have not checked in for more than N hours',
    inputSchema: {
      type: 'object',
      properties: {
        sinceHours: { type: 'number', description: 'Hours since last check-in (default: 48)' }
      }
    }
  },
  {
    name: 'get_devices_pending_patches',
    description: 'List devices with pending or failed OS patches across the fleet',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['PENDING', 'FAILED'], description: 'Patch status filter (default: PENDING)' }
      }
    }
  },
  {
    name: 'get_activities',
    description: 'Query the NinjaOne system-wide activity log',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number', description: 'Results per page (default: 50)' },
        after: { type: 'number', description: 'Return activities after this activity ID' },
        olderThan: { type: 'number', description: 'Return activities older than this activity ID' },
        newerThan: { type: 'number', description: 'Return activities newer than this activity ID' },
        type: { type: 'string', description: 'Activity type filter' },
        df: { type: 'string', description: 'Device filter (e.g., "org = 1")' },
        user: { type: 'number', description: 'Filter by user ID' },
        status: { type: 'string', description: 'Filter by status' }
      }
    }
  },
  {
    name: 'export_readonly_audit',
    description: 'Run an approved read-only NinjaOne audit template and save a complete TXT or JSON artifact under the configured exports directory.',
    inputSchema: {
      type: 'object',
      properties: {
        template: {
          type: 'string',
          enum: ['device_activity', 'organization_activity', 'device_inventory', 'patch_reboot', 'ticket_device'],
          description: 'Approved audit workflow'
        },
        deviceId: { type: 'number', description: 'Required by device_activity and patch_reboot' },
        organizationId: { type: 'number', description: 'Required by organization_activity and device_inventory' },
        ticketId: { type: 'number', description: 'Required by ticket_device' },
        boardId: { type: 'number', description: 'Optional explicit board scan for ticket_device' },
        startTime: { type: 'string', description: 'Optional ISO start timestamp' },
        endTime: { type: 'string', description: 'Optional ISO end timestamp' },
        searchTerms: { type: 'array', items: { type: 'string' }, description: 'Optional case-insensitive terms searched across all returned fields' },
        format: { type: 'string', enum: ['txt', 'json'], description: 'Output format (default txt)' },
        outputName: { type: 'string', description: 'Optional filename stem; path components are removed' },
        maxPages: { type: 'number', description: 'Pagination safety limit, 1-500 (default 50)' },
        maxItems: { type: 'number', description: 'Total-item safety limit (default 100000)' }
      },
      required: ['template']
    }
  },

  // Phase 4 — Script execution & policy management

  {
    name: 'list_automations',
    description: 'List all saved automation scripts/tasks in NinjaOne',
    inputSchema: {
      type: 'object',
      properties: {
        lang: { type: 'string', description: 'Optional script language filter, such as powershell' }
      }
    }
  },
  {
    name: 'get_device_scripting_options',
    description: 'List the saved scripts and built-in actions that NinjaOne reports as available for a specific device',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'number', description: 'Device ID' },
        lang: { type: 'string', description: 'Optional script language filter, such as powershell' }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'run_device_script',
    description: 'Execute a saved automation script on a device. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'number', description: 'Device ID' },
        scriptId: { type: 'number', description: 'Script/automation ID from NinjaOne' },
        type: { type: 'string', enum: ['ACTION', 'SCRIPT'], description: 'Script type (default: SCRIPT)' },
        runAs: { type: 'string', description: 'Execution context (default: SYSTEM)' },
        parameters: { type: 'string', description: 'Script parameters string' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['deviceId', 'scriptId']
    }
  },
  {
    name: 'run_device_powershell',
    description: 'Run an explicitly approved PowerShell command through the configured Solve4x runner script. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'number', description: 'Device ID' },
        command: { type: 'string', description: 'Exact PowerShell command to execute' },
        timeoutSeconds: { type: 'number', description: 'Command timeout, 1-900 seconds (default: 120)' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['deviceId', 'command']
    }
  },
  {
    name: 'get_powershell_result',
    description: 'Find a recent Solve4x PowerShell runner activity by run ID and extract its structured result when available',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'number', description: 'Device ID' },
        runId: { type: 'string', description: 'Run ID returned by run_device_powershell' }
      },
      required: ['deviceId', 'runId']
    }
  },
  {
    name: 'get_script_result',
    description: 'Poll the result of a previously triggered script run',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'number', description: 'Device ID' },
        activityId: { type: 'number', description: 'Activity ID from the script run' }
      },
      required: ['deviceId', 'activityId']
    }
  },
  {
    name: 'get_policy',
    description: 'Get full detail for a specific policy',
    inputSchema: {
      type: 'object',
      properties: { policyId: { type: 'number', description: 'Policy ID' } },
      required: ['policyId']
    }
  },
  {
    name: 'assign_device_policy',
    description: 'Assign a policy to a device. Set confirm=true to execute; default is dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'number', description: 'Device ID' },
        policyId: { type: 'number', description: 'Policy ID to assign' },
        confirm: { type: 'boolean', description: 'Set to true to execute. Default false (dry-run).' }
      },
      required: ['deviceId', 'policyId']
    }
  },
  {
    name: 'get_pending_devices',
    description: 'List all devices awaiting approval',
    inputSchema: { type: 'object', properties: {} }
  },

  // ── Workspace: entity resolution, sync, history, filters, context ──
  {
    name: 'resolve_devices',
    description: 'Resolve device names or IDs to device IDs via the local entity cache. Accepts name or names[]. Ambiguous names return a candidate list; numeric input is treated as an ID.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: ['string', 'number'], description: 'Device system/display/DNS name, or ID' },
        names: { type: 'array', items: { type: ['string', 'number'] }, description: 'Batch list of names or IDs (max 50)' },
        organization: { type: ['string', 'number'], description: 'Scope to an organization name or ID' },
        refresh: { type: 'boolean', description: 'Re-sync devices from NinjaOne before resolving' }
      }
    }
  },
  {
    name: 'resolve_organizations',
    description: 'Resolve organization names or IDs to organization IDs via the local entity cache. Accepts name or names[].',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: ['string', 'number'], description: 'Organization name, or ID' },
        names: { type: 'array', items: { type: ['string', 'number'] }, description: 'Batch list of names or IDs (max 50)' },
        refresh: { type: 'boolean', description: 'Re-sync organizations before resolving' }
      }
    }
  },
  {
    name: 'resolve_locations',
    description: 'Resolve location names or IDs to location IDs via the local entity cache.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: ['string', 'number'], description: 'Location name, or ID' },
        names: { type: 'array', items: { type: ['string', 'number'] }, description: 'Batch list of names or IDs (max 50)' },
        organization: { type: ['string', 'number'], description: 'Scope to an organization name or ID' },
        refresh: { type: 'boolean', description: 'Re-sync locations before resolving' }
      }
    }
  },
  {
    name: 'resolve_policies',
    description: 'Resolve policy names or IDs to policy IDs via the local entity cache.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: ['string', 'number'], description: 'Policy name, or ID' },
        names: { type: 'array', items: { type: ['string', 'number'] }, description: 'Batch list of names or IDs (max 50)' },
        refresh: { type: 'boolean', description: 'Re-sync policies before resolving' }
      }
    }
  },
  {
    name: 'sync_entities',
    description: 'Sync NinjaOne entities into the local cache now and report what changed. Runs automatically when the cache is stale.',
    inputSchema: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: { type: 'string', enum: ['devices', 'organizations', 'policies', 'locations'] },
          description: 'Entity types to sync (default: all)'
        }
      }
    }
  },
  {
    name: 'get_entity_changes',
    description: 'List field-level changes detected during entity syncs (e.g. devices going offline, new devices, renames).',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: { type: 'string', enum: ['device', 'organization', 'location', 'policy'], description: 'Entity type filter' },
        entityId: { type: 'number', description: 'Specific entity ID filter' },
        field: { type: 'string', description: 'Field filter (e.g. offline, system_name, __appeared__, __disappeared__)' },
        since: { type: ['string', 'number'], description: 'Only changes at/after this time — ISO timestamp or epoch ms' },
        limit: { type: 'number', description: 'Max rows (default 200)' }
      }
    }
  },
  {
    name: 'get_operation_journal',
    description: 'Read the local journal of command-profile tool calls (dry-runs and executions), newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: ['string', 'number'], description: 'ISO timestamp or epoch ms' },
        tool: { type: 'string', description: 'Tool name filter' },
        limit: { type: 'number', description: 'Max rows (default 100)' }
      }
    }
  },
  {
    name: 'save_filter',
    description: 'Save a named parameter preset (e.g. df/org/detail) reusable via the filter param on supported tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Filter name' },
        entityType: { type: 'string', enum: ['devices', 'organizations', 'locations', 'policies', 'tickets', 'alerts'], description: 'Entity the filter applies to' },
        params: { type: 'object', description: 'Parameter object merged into the target tool call' }
      },
      required: ['name', 'entityType', 'params']
    }
  },
  {
    name: 'list_saved_filters',
    description: 'List saved parameter presets.',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: { type: 'string', description: 'Optional entity type filter' }
      }
    }
  },
  {
    name: 'delete_saved_filter',
    description: 'Delete a saved parameter preset by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Filter name' }
      },
      required: ['name']
    }
  },
  {
    name: 'set_context',
    description: 'Set a sticky session organization scope (name or ID). Subsequent tools default to it when their org param is omitted. Pass null to clear.',
    inputSchema: {
      type: 'object',
      properties: {
        organization: { type: ['string', 'number', 'null'], description: 'Organization name/ID, or null to clear' }
      },
      required: ['organization']
    }
  },
  {
    name: 'get_context',
    description: 'Show the current session context (organization scope) and local cache counts.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'capture_device_snapshot',
    description: 'Collect an on-demand device evidence snapshot (read-only API resources) and seal an immutable manifest. Returns a capture run id and snapshot id.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: ['string', 'number'], description: 'Device name or ID' },
        profile: { type: 'string', enum: ['quick', 'standard', 'full'], description: 'Resource profile (default standard)' },
        resources: { type: 'array', items: { type: 'string' }, description: 'Explicit resource list overrides the profile' }
      },
      required: ['device']
    }
  },
  {
    name: 'get_capture_status',
    description: 'Check a snapshot capture run: status, request count, and per-resource coverage.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'Capture run id from capture_device_snapshot' } },
      required: ['jobId']
    }
  },
  {
    name: 'list_device_snapshots',
    description: 'List sealed snapshot manifests for a device, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: ['string', 'number'], description: 'Device name or ID' },
        since: { type: ['string', 'number'], description: 'ISO timestamp or epoch ms' },
        until: { type: ['string', 'number'], description: 'ISO timestamp or epoch ms' },
        limit: { type: 'number', description: 'Max rows (default 50)' }
      },
      required: ['device']
    }
  },
  {
    name: 'get_device_snapshot',
    description: 'Fetch one sealed snapshot manifest: resource coverage and observation references (detail=summary by default).',
    inputSchema: {
      type: 'object',
      properties: {
        snapshotId: { type: 'string', description: 'Snapshot id from list_device_snapshots' },
        detail: { type: 'string', enum: ['summary', 'full'], description: 'summary = coverage only; full includes observation records' }
      },
      required: ['snapshotId']
    }
  },
  {
    name: 'compare_device_snapshots',
    description: 'Deterministic semantic diff between two sealed snapshots of the same device. Coverage-aware: missing or partial resources are not_comparable, never false removals.',
    inputSchema: {
      type: 'object',
      properties: {
        baselineId: { type: 'string', description: 'Earlier snapshot id' },
        comparisonId: { type: 'string', description: 'Later snapshot id' },
        resources: { type: 'array', items: { type: 'string' }, description: 'Limit to these resource types' },
        limit: { type: 'number', description: 'Max changed resources returned (default 20)' }
      },
      required: ['baselineId', 'comparisonId']
    }
  },
  {
    name: 'get_snapshot_resource',
    description: 'Read one resource observation (allowlisted canonical content) from a snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        observationId: { type: 'string', description: 'Observation id from get_device_snapshot' },
        detail: { type: 'string', enum: ['summary', 'full'], description: 'summary omits item bodies' }
      },
      required: ['observationId']
    }
  },
  {
    name: 'get_device_change_summary',
    description: 'Meaningful device changes since a time — routine last_contact ticks excluded and counted separately.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: ['string', 'number'], description: 'Device name or ID' },
        since: { type: ['string', 'number'], description: 'ISO timestamp or epoch ms (default: 7 days ago)' }
      },
      required: ['device']
    }
  },
  {
    name: 'list_runbooks',
    description: 'Discover reviewed runbooks (bounded diagnostic/maintenance scripts). Returns compact summaries with parameter names — use get_runbook for full schema.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter: diagnostic, maintenance, administration' },
        query: { type: 'string', description: 'Free-text match on id/title/purpose' }
      }
    }
  },
  {
    name: 'get_runbook',
    description: 'Full runbook detail: typed parameter schema, applicability, classification, limits, review metadata, script digest.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Runbook id, e.g. diag/service-state' },
        version: { type: 'number', description: 'Specific version (default: latest published)' }
      },
      required: ['id']
    }
  },
  {
    name: 'select_devices',
    description: 'Materialize a FROZEN device set for batch work. Returns a selection handle + count + preview — member ids stay server-side. Re-evaluating a filter creates a new selection; an approved plan never expands. One organization per selection.',
    inputSchema: {
      type: 'object',
      properties: {
        orgId: { type: ['string', 'number'], description: 'Organization name or ID — scopes the set' },
        offline: { type: 'boolean', description: 'Filter: true = offline devices only' },
        q: { type: 'string', description: 'Name/display/DNS substring match' },
        deviceIds: { type: 'array', items: { type: 'number' }, description: 'Explicit device id list (resolved names work too)' }
      }
    }
  },
  {
    name: 'get_selection',
    description: 'Inspect a selection handle: frozen count, member preview, exclusions with reasons, criteria, expiry.',
    inputSchema: {
      type: 'object',
      properties: {
        selectionId: { type: 'string', description: 'Handle from select_devices' }
      },
      required: ['selectionId']
    }
  },
  {
    name: 'list_selections',
    description: 'List recent frozen selections for cross-session resume.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max rows (default 20)' }
      }
    }
  },
  {
    name: 'create_plan',
    description: 'Create an immutable execution plan — one device (deviceId) or a frozen device set (selectionId + optional canarySize). Either a reviewed runbook (runbookId + params) or custom PowerShell. Returns plan id, hash, and a review link for human approval. Creating a plan executes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: ['string', 'number'], description: 'Device name or ID — single-target plan' },
        selectionId: { type: 'string', description: 'Frozen selection handle — batch plan across all members' },
        canarySize: { type: 'number', description: 'Batch only: dispatch this many first, hold the rest until canaries verify (or UI release)' },
        runbookId: { type: 'string', description: 'Reviewed runbook id (mutually exclusive with command)' },
        runbookVersion: { type: 'number', description: 'Pinned version (default: latest published)' },
        params: { type: 'object', description: 'Runbook parameters — validated server-side, bound as data' },
        command: { type: 'string', description: 'Custom PowerShell (mutually exclusive with runbookId)' },
        timeoutSeconds: { type: 'number', description: 'Timeout 1-900s (default 120)' }
      }
    }
  },
  {
    name: 'dispatch_plan',
    description: 'Dispatch an already-approved plan. The trusted approval happens in the command-center UI — this submits the work bound to that approval. Without a live approval returns approval_required.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan id from create_plan' }
      },
      required: ['planId']
    }
  },
  {
    name: 'get_operation',
    description: 'Read one operation: status, device, runbook, receipt summary, evidence references. Poll this to follow dispatch → result.',
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string', description: 'Operation id' },
        detail: { type: 'string', enum: ['summary', 'full'], description: 'full includes bounded stdout/stderr' }
      },
      required: ['operationId']
    }
  },
  {
    name: 'list_operations',
    description: 'List recent operations for cross-session resume. Bounded rows (default 20) with status/since filters and a created_at cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter: dispatching, accepted, verified, failed, cancel_requested' },
        since: { type: ['string', 'number'], description: 'ISO timestamp or epoch ms' },
        limit: { type: 'number', description: 'Max rows (default 20, max 200)' },
        cursor: { type: 'number', description: 'created_at cursor from a previous page' }
      }
    }
  },
  {
    name: 'cancel_operation',
    description: 'Request cancellation of remaining work. Only undispatched work can be canceled — upstream-accepted runs are flagged and reconciled honestly. On batch ops, queued/held targets cancel outright.',
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string', description: 'Operation id' }
      },
      required: ['operationId']
    }
  },
  {
    name: 'generate_report',
    description: 'Windowed management report over the evidence model: work performed (verified vs attempted), observed software removals, coverage gaps. Customizable duration — sinceDays (1-400, default 91 = quarter) or explicit ISO since/until. Markdown or JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceDays: { type: 'number', description: 'Look-back days, 1-400 (default 91 — quarterly)' },
        since: { type: 'string', description: 'ISO date start (overrides sinceDays)' },
        until: { type: 'string', description: 'ISO date end (default: now)' },
        orgId: { type: ['string', 'number'], description: 'Scope to one organization' },
        format: { type: 'string', enum: ['json', 'markdown'], description: 'markdown = management-readable document' },
        reportType: { type: 'string', enum: ['operations', 'org'], description: 'operations = work+software (default); org = adds infrastructure state and review outcomes (requires orgId)' }
      }
    }
  },
  {
    name: 'list_operation_targets',
    description: 'Per-target results for a batch operation: status, device, error/receipt per target, seq-cursor pagination. Parent status conserves the frozen count — no target disappears.',
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string', description: 'Batch operation id' },
        status: { type: 'string', description: 'Filter: held, queued, submitting, accepted, verified, failed, skipped, canceled, unknown' },
        limit: { type: 'number', description: 'Max rows (default 50, max 200)' },
        cursor: { type: 'number', description: 'seq cursor from a previous page' }
      },
      required: ['operationId']
    }
  },
  {
    name: 'get_infrastructure_summary',
    description: 'Organization infrastructure overview: entity counts by category and current status (observed/not_observed/conflicting), collection coverage per source, open findings, conflicts. Read-only — answers from stored evidence, never probes endpoints.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' }
      },
      required: ['org']
    }
  },
  {
    name: 'list_infrastructure_entities',
    description: 'Known infrastructure entities for an org: domain, forest, domain-controller, fsmo-role, site, dns-server, dns-zone, dhcp-server, dhcp-scope, gpo, container. Compact rows with current attrs, status, and last-collected time. Evidence-backed — each row links to the producing operation.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        category: { type: 'string', description: 'domain | forest | domain-controller | fsmo-role | site | dns-server | dns-zone | dhcp-server | dhcp-scope | gpo | container' },
        namespace: { type: 'string', description: 'Scope filter, e.g. domain or server namespace' },
        status: { type: 'string', enum: ['observed', 'not_observed', 'conflicting'], description: 'Current projection status filter' },
        q: { type: 'string', description: 'Name/key substring' },
        asOf: { type: 'string', description: 'Point-in-time browse: ISO date/datetime — replays the latest evidence collected at-or-before that time (e.g. "2026-03-01"). Response discloses the evidence horizon; absent means not-yet-collected, not provably absent.' },
        limit: { type: 'number', description: 'Max rows (default 50, max 200)' },
        cursor: { type: 'number', description: 'rowid cursor from a previous page' }
      },
      required: ['org']
    }
  },
  {
    name: 'get_infrastructure_entity',
    description: 'One infrastructure entity: current projection attrs/status, observation history, relationships (GPO links, FSMO holders, scope hosts), conflicts, and the producing operations/evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        entityId: { type: 'string', description: 'Entity id from list_infrastructure_entities' }
      },
      required: ['org', 'entityId']
    }
  },
  {
    name: 'get_infrastructure_coverage',
    description: 'Collection coverage for an org: which sources/sections were queried, status (complete/partial/failed/unverified), enumerated counts, last collection times, and ingestion backlog. "Not collected" is disclosed, never implied.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' }
      },
      required: ['org']
    }
  },
  {
    name: 'get_infrastructure_changes',
    description: 'Infrastructure observations within a window (default last 90 days): entity observations with collected time and producing operation — the evidence-backed change feed.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        sinceDays: { type: 'number', description: 'Look back N days (default 90, max 400)' },
        since: { type: 'string', description: 'ISO date lower bound (overrides sinceDays)' },
        until: { type: 'string', description: 'ISO date upper bound (default now)' },
        category: { type: 'string', description: 'Category filter' },
        limit: { type: 'number', description: 'Max rows (default 100, max 300)' }
      },
      required: ['org']
    }
  },
  {
    name: 'get_endpoint_infrastructure',
    description: 'Infrastructure context for one endpoint: candidate domain/DHCP/scope associations labeled with their basis (dns-suffix match, ip-in-range). Candidates are hypotheses, not proven links.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: ['string', 'number'], description: 'Device name or ID' }
      },
      required: ['device']
    }
  },
  {
    name: 'get_review_digest',
    description: 'Compact review digest for an organization: open items, material reassessments, unanswered questions, and review-due decisions. Use this to answer "what needs my input?" — bounded, never a full dump. Local records only; never collects or executes.',
    inputSchema: {
      type: 'object',
      properties: { org: { type: ['string', 'number'], description: 'Organization name or ID' } },
      required: ['org']
    }
  },
  {
    name: 'list_review_items',
    description: 'Review items (observations, risks, improvements) for an org with filters. Proposed items are unconfirmed AI/rule assessments — distinguish them from human-reviewed decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        type: { type: 'string', enum: ['observation', 'risk', 'improvement'] },
        workflow: { type: 'string', enum: ['new', 'triage', 'awaiting_context', 'reviewed', 'closed'] },
        disposition: { type: 'string', enum: ['none', 'investigate', 'monitor', 'accept_risk', 'pursue_improvement', 'defer', 'dismiss', 'duplicate', 'superseded', 'verified_resolved', 'unverified_closure'] },
        assessment: { type: 'string', enum: ['unassessed', 'proposed', 'confirmed', 'inconclusive', 'not_applicable'] },
        category: { type: 'string' },
        q: { type: 'string', description: 'Title substring' },
        limit: { type: 'number', description: 'Max rows (default 50, max 200)' },
        cursor: { type: 'number' }
      },
      required: ['org']
    }
  },
  {
    name: 'get_review_item',
    description: 'One review item in full: current revision (what was noticed, why it matters, what is known vs unknown), evidence links, questions and answers, decisions, related operations, and event history.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        itemId: { type: 'string' },
        includeHistory: { type: 'boolean', description: 'Include the event log (default true)' }
      },
      required: ['org', 'itemId']
    }
  },
  {
    name: 'list_review_questions',
    description: 'Review questions for an org — open, answered, needs_clarification. Questions are first-class objects; answering through this tool persists the answer with your harness attribution.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        status: { type: 'string', enum: ['open', 'answered', 'needs_clarification', 'withdrawn', 'superseded'] }
      },
      required: ['org']
    }
  },
  {
    name: 'list_org_annotations',
    description: 'Human-supplied organization context: lifecycle (decommissioned servers), ownership, intent, exceptions — with attribution (direct vs reported). Context, never machine-collected evidence.',
    inputSchema: {
      type: 'object',
      properties: { org: { type: ['string', 'number'], description: 'Organization name or ID' } },
      required: ['org']
    }
  },
  {
    name: 'propose_review_item',
    description: 'Propose an observation, risk, or improvement with evidence references (validated against same-org retained records). Proposals stay proposed — they create no approval and execute nothing. Requires reviewWritesEnabled policy grant.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        itemType: { type: 'string', enum: ['observation', 'risk', 'improvement'] },
        category: { type: 'string', description: 'e.g. security, resilience, lifecycle, documentation' },
        title: { type: 'string' },
        summary: { type: 'string', description: 'What was observed — literal facts' },
        rationale: { type: 'string', description: 'Why it was flagged — reasoning chain or rule id' },
        consequence: { type: 'string', description: 'Possible consequence, scoped and conditional' },
        knownsUnknowns: { type: 'string', description: 'What is known vs unknown, alternative explanations' },
        impact: { type: 'string', description: 'Suggested impact if true: low|medium|high|unknown' },
        urgency: { type: 'string', description: 'Suggested priority to investigate' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'How bad if true — drives priority score' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How sure the evidence is — drives priority score' },
        subject: { type: 'object', description: 'Affected object identity (entity category/namespace/key, setting path)' },
        evidence: { type: 'array', items: { type: 'object' }, description: 'Evidence refs: {linkType: entity|observation|operation|annotation|relationship, entityId|observationId|operationId|annotationId, fieldPath, note}' },
        questions: { type: 'array', items: { type: 'object' }, description: 'Needed context: {question, whyItMatters, answerType: text|yes_no_unknown|entity|owner|date}' },
        sourceId: { type: 'string', description: 'Rule id or analysis identifier' },
        sourceVersion: { type: 'string', description: 'Rule/model version' },
        idempotencyKey: { type: 'string', description: 'Client retry key — resubmission returns the same item' }
      },
      required: ['org', 'itemType', 'title']
    }
  },
  {
    name: 'revise_review_item',
    description: 'Revise a review item\'s content (title/summary/rationale/consequence/impact). Requires expectedRevision for optimistic concurrency — a stale edit fails rather than overwriting a newer revision.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        itemId: { type: 'string' },
        expectedRevision: { type: 'number' },
        title: { type: 'string' },
        summary: { type: 'string' },
        rationale: { type: 'string' },
        consequence: { type: 'string' },
        knownsUnknowns: { type: 'string' },
        impact: { type: 'string' },
        urgency: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
      },
      required: ['org', 'itemId', 'expectedRevision']
    }
  },
  {
    name: 'ask_review_question',
    description: 'Attach a question to a review item (or an org-level onboarding question). Small, specific, answerable — the user sees it in the digest and UI.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        itemId: { type: 'string', description: 'Omit for an org-level question' },
        question: { type: 'string' },
        whyItMatters: { type: 'string' },
        answerType: { type: 'string', enum: ['text', 'yes_no_unknown', 'entity', 'owner', 'date'] }
      },
      required: ['org', 'question']
    }
  },
  {
    name: 'answer_review_question',
    description: 'Record the user\'s answer to a review question. Stored as a reported human statement attributed to this harness session — honest provenance, not fabricated direct-human identity. "I don\'t know" is a valid answer.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        questionId: { type: 'string' },
        answer: { type: 'string', description: 'The user\'s answer, verbatim' },
        normalized: { type: 'object', description: 'Optional parsed form, e.g. {value: "unknown"} or {entityId}' },
        actor: { type: 'string', description: 'Optional answering identity for attribution — e.g. the model ("claude-5.1", "gpt-5.6") or user name ("james"). Recorded as mcp:<profile>:<actor> so the transport stays visible.' },
        idempotencyKey: { type: 'string' }
      },
      required: ['org', 'questionId', 'answer']
    }
  },
  {
    name: 'add_org_annotation',
    description: 'Record human-supplied organization context (lifecycle, ownership, intent, exception). E.g. "DC01-3 are decommissioned" — stored as a reported statement scoped to named subjects; it informs interpretation but is never promoted to machine-collected evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        annotationType: { type: 'string', enum: ['lifecycle', 'ownership', 'intent', 'exception', 'context'] },
        subject: { type: 'object', description: 'Scope, e.g. {entities:["DC01","DC02","DC03"]} — match actual identities, not wildcards' },
        text: { type: 'string', description: 'The supplied context, verbatim or closely summarized' },
        sourceNote: { type: 'string', description: 'How the statement was supplied (e.g. "user statement in session")' }
      },
      required: ['org', 'annotationType', 'text']
    }
  },
  {
    name: 'record_review_decision',
    description: 'Record a human disposition on a review item (investigate, monitor, accept_risk, pursue_improvement, defer, dismiss, duplicate, superseded, verified_resolved, unverified_closure). Through this tool the provenance is "delegated" — you assert the user gave explicit direction. verified_resolved requires an evidence basis; closing without verification is unverified_closure. No decision executes anything.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        itemId: { type: 'string' },
        disposition: { type: 'string', enum: ['investigate', 'monitor', 'accept_risk', 'pursue_improvement', 'defer', 'dismiss', 'duplicate', 'superseded', 'verified_resolved', 'unverified_closure'] },
        rationale: { type: 'string' },
        owner: { type: 'string' },
        scopeNote: { type: 'string' },
        reviewDueAt: { type: 'number', description: 'Epoch ms — revisit date for accept_risk/defer/monitor' },
        evidenceBasis: { type: 'object', description: 'Required for verified_resolved: what evidence demonstrates resolution' },
        canonicalItemId: { type: 'string', description: 'For duplicate: the canonical item' },
        idempotencyKey: { type: 'string' }
      },
      required: ['org', 'itemId', 'disposition']
    }
  },
  {
    name: 'suppress_review',
    description: 'Suppress routine resurfacing for a scope (fingerprint, ruleId, or itemId) with reason and optional expiry. Hides recurrence — never deletes facts or decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        fingerprint: { type: 'string' },
        ruleId: { type: 'string' },
        itemId: { type: 'string' },
        reason: { type: 'string' },
        expiresAt: { type: 'number', description: 'Epoch ms, optional' }
      },
      required: ['org', 'reason']
    }
  },
  {
    name: 'link_review_operation',
    description: 'Attach an existing operation or plan to a review item as related work (proposed|approved|executed|verification). A reference only — it neither approves nor dispatches; execution stays on the normal plan→approve path.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: ['string', 'number'], description: 'Organization name or ID' },
        itemId: { type: 'string' },
        operationId: { type: 'string' },
        planId: { type: 'string' },
        linkKind: { type: 'string', enum: ['proposed', 'approved', 'executed', 'verification'] }
      },
      required: ['org', 'itemId', 'linkKind']
    }
  }
];

/**
 * NinjaONE MCP Server Class with multiple transports
 */
export class NinjaOneMCPServer {
  private server: Server;
  private api: NinjaOneAPI;
  private security: RuntimeSecurity;
  private exposedTools: any[];
  private endpointCatalog: EndpointCatalog;
  private store: EntityStore | null = null;
  private resolver: EntityResolver | null = null;
  /** Per-session org scope — never daemon-global (invariant 12). */
  private sessionOrgs = new Map<string, number>();
  private connectionId: string | null = null;
  /** Invalidation events emitted after entity syncs; consumed by the local server adapter. */
  public readonly invalidations = new EventEmitter();
  private recentInvalidations: Array<Record<string, unknown>> = [];
  private eventSeq = 0;

  constructor() {
    try {
      this.security = loadRuntimeSecurity();
      this.api = new NinjaOneAPI();
      this.endpointCatalog = new EndpointCatalog();
      try {
        const conn = resolveConnection(this.api.getBaseUrl());
        this.connectionId = conn.connection?.id ?? null;
        this.store = new EntityStore(conn.dbPath, {
          connectionId: conn.connection?.id,
          apiOrigin: conn.connection?.apiOrigin,
        });
        this.resolver = new EntityResolver(this.api, this.store);
      } catch (storeError) {
        console.error('Local entity store unavailable; name resolution tools disabled:', storeError);
        this.store = null;
        this.resolver = null;
      }
      this.exposedTools = filterTools(TOOLS, this.security).map((tool) => this.applyNameOrIdSchema(tool));
      this.server = new Server(
        {
          name: 'ninjaone-mcp-server',
          version: '1.2.15',
        },
        {
          capabilities: {
            tools: {}
          }
        }
      );
      this.setupToolHandlers();
    } catch (error) {
      console.error('Failed to initialize NinjaONE MCP Server:', error);
      throw error;
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.exposedTools
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return this.executeToolCall(name, args || {}, 'stdio');
    });
  }

  /**
   * The single dispatch path for every adapter (stdio MCP handler, local
   * HTTP server, scheduler). Guards run in order: profile allowlist →
   * name-or-ID resolution → confirmation gate → org boundary → dispatch →
   * journal. sessionId scopes set_context state per caller session.
   */
  public async executeToolCall(name: string, args: any, sessionId: string = 'stdio') {
    const safeArgs = args || {};
    let resolved: ResolvedArgs = {};
    try {
      if (!isToolAllowed(name, this.security)) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool is not available in the ${this.security.profile} profile`);
      }
      resolved = await this.resolveEntityArgs(name, safeArgs, sessionId);
      if (requiresApprovalPipeline(name, this.security, planApprovalRequired())) {
        // confirm:true is a model-supplied flag, not approval. Endpoint
        // actions without a plan path are refused before any upstream call.
        this.journalCall(name, safeArgs, resolved, 'blocked', new Error('approval pipeline required'));
        return this.result({
          code: 'APPROVAL_PIPELINE_REQUIRED',
          tool: name,
          message: `"${name}" acts on endpoints and has no trusted-approval path, so it cannot run from an MCP call (confirm:true is not approval). ` +
            'Use create_plan with run_device_powershell (a reviewed runbook or an exact script) — the plan lands in the command center Approvals queue for a human.',
          nextAction: 'create_plan',
        });
      }
      if (toolRequiresGenericConfirmation(name) && safeArgs.confirm !== true) {
        this.journalCall(name, safeArgs, resolved, 'dry_run');
        return this.dryRun(`Would execute privileged command tool "${name}". Review the target and arguments before confirming.`);
      }
      await this.enforceOrganizationBoundary(name, safeArgs, resolved);
      console.error(`Executing tool: ${name}`);
      const result = await this.routeToolCall(name, safeArgs, resolved, sessionId);
      const text = result?.content?.[0]?.text ?? '';
      this.journalCall(name, safeArgs, resolved, text.startsWith('DRY RUN') ? 'dry_run' : 'ok');
      return result;
    } catch (error) {
      const status = error instanceof McpError && error.code === ErrorCode.InvalidRequest ? 'blocked' : 'error';
      this.journalCall(name, safeArgs, resolved, status, error);
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InternalError,
        `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private sessionOrg(sessionId: string): number | null {
    return this.sessionOrgs.get(sessionId) ?? null;
  }

  private recordInvalidations(reports: Array<{ entityType: string; added: number; changed: number; removed: number }>): void {
    for (const r of reports) {
      const event = {
        seq: ++this.eventSeq,
        kind: 'entities',
        entityType: r.entityType,
        added: r.added,
        changed: r.changed,
        removed: r.removed,
        at: Date.now(),
      };
      this.recentInvalidations.push(event);
      if (this.recentInvalidations.length > 50) this.recentInvalidations.shift();
      this.invalidations.emit('entities', event);
    }
  }

  public getRecentInvalidations(): Array<Record<string, unknown>> {
    return [...this.recentInvalidations];
  }

  /** The principal this server executes as (profile + credential kind). */
  public getPrincipal() {
    return this.api.getPrincipal();
  }

  /** Local entity store (may be null when unavailable). */
  public getStore(): EntityStore | null {
    return this.store;
  }

  /** Upstream API client — shared by the local server adapter. */
  public getApi(): NinjaOneAPI {
    return this.api;
  }

  /** Runtime security (profile + principal + policy). */
  public getSecurity(): RuntimeSecurity {
    return this.security;
  }

  private requireStore(): EntityStore {
    if (!this.store) {
      throw new McpError(ErrorCode.InternalError, 'Local entity store is unavailable on this server instance');
    }
    return this.store;
  }

  private requireResolver(): EntityResolver {
    if (!this.resolver) {
      throw new McpError(ErrorCode.InternalError, 'Entity resolver is unavailable on this server instance');
    }
    return this.resolver;
  }

  /**
   * Resolve name-or-ID params in place before dispatch. Resolved records are
   * returned so the organization boundary check can reuse them instead of
   * re-fetching. Session context supplies a default organization when the
   * tool has an org slot but none was provided.
   */
  private async resolveEntityArgs(name: string, args: any, sessionId: string = 'stdio'): Promise<ResolvedArgs> {
    const resolved: ResolvedArgs = {};
    if (!this.resolver) return resolved;
    const sessionOrgId = this.sessionOrg(sessionId);

    const orgKeys = ORG_ID_PARAMS[name];
    if (orgKeys) {
      for (const key of orgKeys) {
        if (typeof args[key] === 'string' && !/^\d+$/.test(args[key].trim())) {
          resolved.organization = resolved.organization ?? await this.resolver.resolveOrganization(args[key]);
          args[key] = resolved.organization.id;
        } else if (typeof args[key] === 'string' && /^\d+$/.test(args[key].trim())) {
          args[key] = Number(args[key].trim());
        } else if (args[key] === undefined && sessionOrgId !== null) {
          args[key] = sessionOrgId;
        }
      }
    }

    const policyKeys = POLICY_ID_PARAMS[name];
    if (policyKeys) {
      for (const key of policyKeys) {
        if (typeof args[key] === 'string' && !/^\d+$/.test(args[key].trim())) {
          resolved.policy = resolved.policy ?? await this.resolver.resolvePolicy(args[key]);
          args[key] = resolved.policy.id;
        } else if (typeof args[key] === 'string' && /^\d+$/.test(args[key].trim())) {
          args[key] = Number(args[key].trim());
        }
      }
    }

    const deviceKeys = DEVICE_ID_PARAMS[name];
    if (deviceKeys) {
      const orgScope = resolved.organization?.id ?? sessionOrgId ?? undefined;
      for (const key of deviceKeys) {
        const value = args[key];
        if (Array.isArray(value)) {
          const list: ResolvedEntity[] = [];
          for (let i = 0; i < value.length; i++) {
            if (typeof value[i] === 'string' && !/^\d+$/.test(value[i].trim())) {
              const r = await this.resolver.resolveDevice(value[i], { orgId: orgScope });
              value[i] = r.id;
              list.push(r);
            } else {
              const id = Number(value[i]);
              if (Number.isFinite(id)) value[i] = id;
              list.push({ id, orgId: null, label: `id ${id}`, source: 'cache', record: {} });
            }
          }
          resolved.devices = list;
        } else if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
          const r = await this.resolver.resolveDevice(value, { orgId: orgScope });
          args[key] = r.id;
          resolved.device = resolved.device ?? r;
        } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
          args[key] = Number(value.trim());
        }
      }
    }
    return resolved;
  }

  /** Journal every write-tool call (dry-run, ok, blocked, error). Never throws. */
  private journalCall(name: string, args: any, resolved: ResolvedArgs, status: 'ok' | 'dry_run' | 'error' | 'blocked', error?: unknown): void {
    if (!this.store || !WRITE_TOOLS.has(name)) return;
    try {
      const numeric = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const deviceKeys = DEVICE_ID_PARAMS[name] || [];
      const orgKeys = ORG_ID_PARAMS[name] || [];
      this.store.logOperation({
        profile: this.security.profile,
        tool: name,
        args,
        targetDeviceId:
          resolved.device?.id ??
          numeric(args.deviceId) ??
          numeric(args.nodeId) ??
          (deviceKeys.includes('id') ? numeric(args.id) : null),
        targetOrgId:
          resolved.organization?.id ??
          resolved.device?.orgId ??
          numeric(args.organizationId) ??
          numeric(args.orgId) ??
          numeric(args.clientId) ??
          (orgKeys.includes('id') ? numeric(args.id) : null),
        dryRun: status === 'dry_run',
        status,
        error: error ? String(error instanceof Error ? error.message : error) : null,
      });
    } catch (journalError) {
      console.error('Failed to write operation journal:', journalError);
    }
  }

  /** Widen mapped ID params to accept names, and inject detail/filter params. */
  private applyNameOrIdSchema(tool: any): any {
    const props = tool?.inputSchema?.properties;
    if (!props) return tool;
    const widen = (key: string, noun: string) => {
      const prop = props[key];
      if (!prop) return;
      if (prop.type === 'number') {
        prop.type = ['number', 'string'];
        prop.description = `${prop.description || noun + ' ID'} — or ${noun} name (resolved server-side)`.trim();
      } else if (prop.type === 'array' && prop.items?.type === 'number') {
        prop.items = { ...prop.items, type: ['number', 'string'] };
        prop.description = `${prop.description || ''} Entries may be ${noun} IDs or names.`.trim();
      }
    };
    for (const key of DEVICE_ID_PARAMS[tool.name] || []) widen(key, 'device');
    for (const key of ORG_ID_PARAMS[tool.name] || []) widen(key, 'organization');
    for (const key of POLICY_ID_PARAMS[tool.name] || []) widen(key, 'policy');
    if (DETAIL_TOOLS.has(tool.name)) {
      props.detail = {
        type: 'string',
        enum: ['summary', 'full'],
        description: 'summary (default) returns key fields only; full returns raw API objects',
      };
    }
    if (FILTERABLE_TOOLS.has(tool.name)) {
      props.filter = { type: 'string', description: 'Saved filter name — merges its stored params into this call' };
    }
    return tool;
  }

  private dryRun(message: string) {
    return {
      content: [{
        type: 'text',
        text: `DRY RUN — no changes made.\n${message}\nRe-call with confirm=true to execute.`
      }]
    };
  }

  /** Merge a saved filter's stored params under the explicit args. */
  private applySavedFilter(args: any): any {
    if (typeof args?.filter !== 'string') return args;
    const filter = this.requireStore().getFilter(args.filter);
    if (!filter) {
      throw new McpError(ErrorCode.InvalidParams, `No saved filter named "${args.filter}"`);
    }
    const { filter: _omit, ...rest } = args;
    return { ...filter.params, ...rest };
  }

  /** Apply summary projections to list responses unless detail:"full" is set. */
  private applyDetail(data: any, args: any, kind: 'device' | 'organization' | 'ticket' | 'alert'): any {
    if ((args?.detail ?? 'summary') !== 'summary') return data;
    const fn = (row: any) => {
      if (kind === 'device') {
        const orgId = row?.organizationId ?? row?.org_id;
        return summarizeDevice(row, this.store?.orgName(typeof orgId === 'number' ? orgId : Number(orgId) || null));
      }
      if (kind === 'organization') return summarizeOrganization(row);
      if (kind === 'ticket') return summarizeTicket(row);
      return summarizeAlert(row);
    };
    if (Array.isArray(data)) return data.map(fn);
    if (data && typeof data === 'object') {
      for (const key of ['results', 'devices', 'tickets', 'data', 'items', 'alerts']) {
        if (Array.isArray(data[key])) return { ...data, [key]: data[key].map(fn) };
      }
    }
    return data;
  }

  private parseSince(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value));
    if (!Number.isFinite(parsed)) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid "since" value: ${String(value)}`);
    }
    return parsed;
  }

  private entityNameFor(entityType: string, entityId: number): string | null {
    if (!this.store) return null;
    if (entityType === 'device') {
      const d = this.store.getDeviceById(entityId);
      return d ? String(d.system_name ?? d.display_name ?? '') || null : null;
    }
    if (entityType === 'organization') return this.store.orgName(entityId);
    if (entityType === 'location') {
      const row = this.store.getLocationByAnyOrg(entityId);
      return row ? String(row.name ?? '') || null : null;
    }
    if (entityType === 'policy') {
      const p = this.store.getPolicyById(entityId);
      return p ? String(p.name ?? '') || null : null;
    }
    return null;
  }

  /** Device label for dry-run text — reuses the resolved record when available. */
  private async deviceLabel(id: number, resolved?: ResolvedEntity): Promise<string> {
    if (resolved && resolved.id === id && Object.keys(resolved.record).length > 0) {
      const r = resolved.record;
      return String(r.systemName ?? r.system_name ?? r.displayName ?? r.display_name ?? `id ${id}`);
    }
    try {
      const d = await this.api.getDevice(id);
      return String(d.systemName ?? d.displayName ?? 'unknown');
    } catch {
      return 'unknown';
    }
  }

  /**
   * Harness-neutral contract envelope (plan §6): stable schemaVersion,
   * scope, ok/code, concise summary, and a nextAction hint. OpError codes
   * and RunbookError codes surface verbatim — never rewrapped.
   */
  private contract(data: Record<string, unknown>) {
    return this.result({ schemaVersion: 1, connectionId: this.connectionId, ...data });
  }

  private contractError(error: unknown) {
    const code = error instanceof OpError || error instanceof RunbookError ? error.code : 'internal_error';
    return this.contract({
      ok: false,
      code,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private reviewUrl(planId: string): string {
    const port = (process.env.NINJA_SERVE_PORT || '').trim();
    return port ? `http://127.0.0.1:${port}/#/plan/${planId}` : `#/plan/${planId}`;
  }

  private result(data: any) {
    // Use compact JSON to minimise token consumption in Claude Desktop.
    // For array responses, prepend a count so the model knows the size at a glance.
    let text: string;
    if (Array.isArray(data)) {
      text = `{"count":${data.length},"results":${JSON.stringify(data)}}`;
    } else if (data?.results && Array.isArray(data.results)) {
      text = JSON.stringify({ ...data, count: data.results.length });
    } else {
      text = JSON.stringify(data);
    }
    return {
      content: [{
        type: 'text',
        text
      }]
    };
  }

  private async enforceOrganizationBoundary(name: string, args: any, resolved: ResolvedArgs = {}): Promise<void> {
    await enforceOrganizationBoundary(
      this.api,
      this.security.profile,
      this.security.policy.allowedOrganizationIds,
      name,
      args,
      resolved,
    );
  }

  private async routeToolCall(name: string, args: any, resolved: ResolvedArgs = {}, sessionId: string = 'stdio') {
    try {
      switch (name) {
        case 'get_auth_profile':
          return this.result(await this.api.getAuthStatus());
        case 'find_endpoint':
          return this.result(this.endpointCatalog.find(
            args.query || '',
            args.category,
            args.method,
            args.limit || 20,
          ));
        case 'describe_endpoint':
          return this.result(this.endpointCatalog.describe(args.endpoint));
        case 'ninjaone_navigate':
          return this.result(navigateTools(
            args.domain,
            this.security.profile,
            this.exposedTools.map((tool) => tool.name),
          ));
        // ── Device Management (read) ──
        case 'get_devices': {
          const merged = this.applySavedFilter(args);
          const data = await this.api.getDevices(merged.df, merged.pageSize || 50, merged.after);
          return this.result(this.applyDetail(data, merged, 'device'));
        }
        case 'get_devices_complete': {
          const merged = this.applySavedFilter(args);
          if (typeof merged.organizationId === 'string' && !/^\d+$/.test(merged.organizationId.trim())) {
            merged.organizationId = (await this.requireResolver().resolveOrganization(merged.organizationId)).id;
          }
          const data = await getDevicesComplete(this.api, {
            organizationId: merged.organizationId,
            df: merged.df,
            pageSize: merged.pageSize,
            maxPages: merged.maxPages,
            maxItems: merged.maxItems,
          });
          return this.result(this.applyDetail(data, merged, 'device'));
        }
        case 'get_device':
          return this.result(await this.api.getDevice(args.id));
        case 'get_device_dashboard_url':
          return this.result(await this.api.getDeviceDashboardUrl(args.id));
        case 'get_device_software':
          return this.result(await this.api.getDeviceSoftware(args.id));
        case 'get_device_activities':
          return this.result(await this.api.getDeviceActivities(args.id, args.pageSize));
        case 'search_devices_by_name':
          return this.result(await this.searchDevicesByName(args.name, args.limit || 10, sessionId));
        case 'find_windows11_devices':
          return this.result(await this.findWindows11Devices(args.limit || 20));

        // ── Device Management (write — confirm guarded) ──
        case 'reboot_device': {
          const mode = args.mode || 'NORMAL';
          if (!args.confirm) {
            const label = await this.deviceLabel(args.id, resolved.device);
            return this.dryRun(`Would reboot device id=${args.id} (${label}) in ${mode} mode.`);
          }
          return this.result(await this.api.rebootDevice(args.id, mode));
        }
        case 'set_device_maintenance': {
          if (typeof args.id !== 'number') {
            throw new McpError(ErrorCode.InvalidParams, 'Device ID must be a number');
          }
          if (args.mode !== 'ON' && args.mode !== 'OFF') {
            throw new McpError(ErrorCode.InvalidParams, 'Maintenance mode must be ON or OFF');
          }

          let durationSelection: MaintenanceWindowSelection | undefined;
          if (args.mode === 'ON') {
            if (args.duration === null || args.duration === undefined || typeof args.duration !== 'object') {
              throw new McpError(ErrorCode.InvalidParams, 'Duration details are required when enabling maintenance mode');
            }
            const duration = args.duration;
            const permanent = duration.permanent === true;
            if (permanent) {
              durationSelection = { permanent: true };
            } else {
              const value = duration.value;
              const unitRaw = duration.unit;
              if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
                throw new McpError(ErrorCode.InvalidParams, 'Duration value must be a positive number');
              }
              const unit = typeof unitRaw === 'string' ? unitRaw.toUpperCase() : '';
              if (!Object.prototype.hasOwnProperty.call(MAINTENANCE_UNIT_SECONDS, unit)) {
                throw new McpError(ErrorCode.InvalidParams, 'Duration unit must be one of MINUTES, HOURS, DAYS, or WEEKS');
              }
              const seconds = Math.round(value * MAINTENANCE_UNIT_SECONDS[unit as MaintenanceUnit]);
              if (seconds < 15 * 60) {
                throw new McpError(ErrorCode.InvalidParams, 'Maintenance windows must be at least 15 minutes long');
              }
              durationSelection = { permanent: false, value, unit: unit as MaintenanceUnit, seconds };
            }
          }

          if (!args.confirm) {
            const label = await this.deviceLabel(args.id, resolved.device);
            const desc = args.mode === 'OFF'
              ? `Would disable maintenance mode on device id=${args.id} (${label}).`
              : durationSelection?.permanent
                ? `Would enable PERMANENT maintenance mode on device id=${args.id} (${label}).`
                : `Would enable maintenance mode on device id=${args.id} (${label}) for ${(durationSelection as any)?.value} ${(durationSelection as any)?.unit}.`;
            return this.dryRun(desc);
          }
          return this.result(await this.api.setDeviceMaintenance(args.id, args.mode, durationSelection));
        }
        case 'update_device': {
          if (!args.confirm) {
            const label = await this.deviceLabel(args.id, resolved.device);
            const changes: string[] = [];
            if (args.displayName) changes.push(`displayName → "${args.displayName}"`);
            if (args.userData) changes.push(`userData → ${JSON.stringify(args.userData)}`);
            return this.dryRun(`Would update device id=${args.id} (${label}).\nChanges: ${changes.join(', ') || 'none specified'}`);
          }
          const body: any = {};
          if (args.displayName !== undefined) body.displayName = args.displayName;
          if (args.userData !== undefined) body.userData = args.userData;
          return this.result(await this.api.updateDevice(args.id, body));
        }

        // ── Alerts ──
        case 'get_alerts':
          return this.result(this.applyDetail(await this.api.getAlerts(args.df, args.sourceType, args.since), args, 'alert'));
        case 'get_alert':
          return this.result(await this.api.getAlert(args.uid));
        case 'get_device_alerts':
          return this.result(await this.api.getDeviceAlerts(args.id, args.lang));
        case 'reset_alert': {
          if (!args.confirm) {
            const alert = await this.api.getAlert(args.uid);
            const desc = alert.message || alert.subject || 'unknown';
            const devId = alert.deviceId || 'unknown';
            return this.dryRun(`Would reset alert uid=${args.uid} (${desc}) on device id=${devId}.`);
          }
          return this.result(await this.api.resetAlert(args.uid));
        }

        // ── Organizations ──
        case 'get_organizations':
          return this.result(this.applyDetail(await this.api.getOrganizations(args.pageSize, args.after), args, 'organization'));
        case 'get_organization':
          return this.result(await this.api.getOrganization(args.id));
        case 'get_organization_locations':
          return this.result(await this.api.getOrganizationLocations(args.id));
        case 'get_organization_policies':
          return this.result(await this.api.getOrganizationPolicies(args.id));
        case 'generate_organization_installer':
          return this.result(await this.api.generateOrganizationInstaller(args.installerType, args.locationId, args.organizationId));
        case 'create_organization':
          return this.result(await this.api.createOrganization(args.name, args.description, args.nodeApprovalMode, args.tags));
        case 'update_organization':
          return this.result(await this.api.updateOrganization(args.id, args.name, args.description, undefined, args.tags));

        // ── Locations ──
        case 'create_location':
          return this.result(await this.api.createLocation(args.organizationId, args.name, args.address, args.description));
        case 'update_location':
          return this.result(await this.api.updateLocation(args.organizationId, args.locationId, args.name, args.address, args.description));

        // ── Region utilities ──
        case 'list_regions':
          return this.result(this.api.listRegions());
        case 'set_region':
          if (args.baseUrl) this.api.setBaseUrl(args.baseUrl);
          else if (args.region) this.api.setRegion(args.region);
          else throw new McpError(ErrorCode.InvalidParams, 'Provide either region or baseUrl');
          return this.result({ ok: true });

        // ── Device Control ──
        case 'control_windows_service':
          return this.result(await this.api.controlWindowsService(args.id, args.serviceId, args.action));
        case 'configure_windows_service':
          return this.result(await this.api.configureWindowsService(args.id, args.serviceId, args.startupType));

        // ── Patching ──
        case 'scan_device_os_patches':
          return this.result(await this.api.scanDeviceOSPatches(args.id));
        case 'scan_device_software_patches':
          return this.result(await this.api.scanDeviceSoftwarePatches(args.id));
        case 'apply_device_os_patches': {
          if (!args.confirm) {
            const label = await this.deviceLabel(args.id, resolved.device);
            const patchList = (args.patches || []).map((p: any) => p.id || JSON.stringify(p)).join(', ');
            return this.dryRun(`Would apply ${args.patches?.length || 0} OS patch(es) to device id=${args.id} (${label}).\nPatches: ${patchList}`);
          }
          return this.result(await this.api.applyDeviceOSPatches(args.id, args.patches));
        }
        case 'apply_device_software_patches': {
          if (!args.confirm) {
            const label = await this.deviceLabel(args.id, resolved.device);
            const patchList = (args.patches || []).map((p: any) => p.id || JSON.stringify(p)).join(', ');
            return this.dryRun(`Would apply ${args.patches?.length || 0} software patch(es) to device id=${args.id} (${label}).\nPatches: ${patchList}`);
          }
          return this.result(await this.api.applyDeviceSoftwarePatches(args.id, args.patches));
        }

        // ── Users & Roles ──
        case 'get_end_users':
          return this.result(await this.api.getEndUsers());
        case 'get_end_user':
          return this.result(await this.api.getEndUser(args.id));
        case 'create_end_user':
          return this.result(await this.api.createEndUser(
            { firstName: args.firstName, lastName: args.lastName, email: args.email, phone: args.phone, organizationId: args.organizationId, fullPortalAccess: args.fullPortalAccess },
            args.sendInvitation
          ));
        case 'update_end_user':
          return this.result(await this.api.updateEndUser(args.id, args.firstName, args.lastName, args.email, args.phone));
        case 'delete_end_user':
          return this.result(await this.api.deleteEndUser(args.id));
        case 'get_technicians':
          return this.result(await this.api.getTechnicians());
        case 'get_technician':
          return this.result(await this.api.getTechnician(args.id));
        case 'add_role_members':
          return this.result(await this.api.addRoleMembers(args.roleId, args.userIds));
        case 'remove_role_members':
          return this.result(await this.api.removeRoleMembers(args.roleId, args.userIds));

        // ── Contacts ──
        case 'get_contacts':
          return this.result(await this.api.getContacts());
        case 'get_contact':
          return this.result(await this.api.getContact(args.id));
        case 'create_contact':
          return this.result(await this.api.createContact(args.organizationId, args.firstName, args.lastName, args.email, args.phone, args.jobTitle));
        case 'update_contact':
          return this.result(await this.api.updateContact(args.id, args.firstName, args.lastName, args.email, args.phone, args.jobTitle));
        case 'delete_contact':
          return this.result(await this.api.deleteContact(args.id));

        // ── Device approvals & policy ──
        case 'approve_devices': {
          if (!args.confirm) {
            return this.dryRun(`Would ${args.mode} ${args.deviceIds.length} device(s): [${args.deviceIds.join(', ')}].`);
          }
          return this.result(await this.api.approveDevices(args.mode, args.deviceIds));
        }
        case 'get_device_policy_overrides':
          return this.result(await this.api.getDevicePolicyOverrides(args.id));
        case 'reset_device_policy_overrides': {
          if (!args.confirm) {
            const overrides = await this.api.getDevicePolicyOverrides(args.id);
            return this.dryRun(`Would reset all policy overrides on device id=${args.id}.\nCurrent overrides: ${JSON.stringify(overrides, null, 2)}`);
          }
          return this.result(await this.api.resetDevicePolicyOverrides(args.id));
        }
        case 'get_policies':
          return this.result(await this.api.getPolicies(args.templateOnly));

        // ── System Information Queries ──
        case 'query_antivirus_status':
          return this.result(await this.api.queryAntivirusStatus(args.df, args.cursor, args.pageSize || 50));
        case 'query_antivirus_threats':
          return this.result(await this.api.queryAntivirusThreats(args.df, args.cursor, args.pageSize || 50));
        case 'query_computer_systems':
          return this.result(await this.api.queryComputerSystems(args.df, args.cursor, args.pageSize || 50));
        case 'query_device_health':
          return this.result(await this.api.queryDeviceHealth(args.df, args.cursor, args.pageSize || 50));
        case 'query_operating_systems':
          return this.result(await this.api.queryOperatingSystems(args.df, args.cursor, args.pageSize || 50));
        case 'query_logged_on_users':
          return this.result(await this.api.queryLoggedOnUsers(args.df, args.cursor, args.pageSize || 50));

        // ── Hardware Queries ──
        case 'query_processors':
          return this.result(await this.api.queryProcessors(args.df, args.cursor, args.pageSize || 50));
        case 'query_disks':
          return this.result(await this.api.queryDisks(args.df, args.cursor, args.pageSize || 50));
        case 'query_volumes':
          return this.result(await this.api.queryVolumes(args.df, args.cursor, args.pageSize || 50));
        case 'query_network_interfaces':
          return this.result(await this.api.queryNetworkInterfaces(args.df, args.cursor, args.pageSize || 50));
        case 'query_raid_controllers':
          return this.result(await this.api.queryRaidControllers(args.df, args.cursor, args.pageSize || 50));
        case 'query_raid_drives':
          return this.result(await this.api.queryRaidDrives(args.df, args.cursor, args.pageSize || 50));

        // ── Software & Patch Queries ──
        case 'query_software':
          return this.result(await this.api.querySoftware(args.df, args.cursor, args.pageSize || 50));
        case 'query_os_patches':
          return this.result(await this.api.queryOSPatches(args.df, args.cursor, args.pageSize || 50));
        case 'query_software_patches':
          return this.result(await this.api.querySoftwarePatches(args.df, args.cursor, args.pageSize || 50));
        case 'query_os_patch_installs':
          return this.result(await this.api.queryOSPatchInstalls(args.df, args.cursor, args.pageSize || 50));
        case 'query_software_patch_installs':
          return this.result(await this.api.querySoftwarePatchInstalls(args.df, args.cursor, args.pageSize || 50));
        case 'query_windows_services':
          return this.result(await this.api.queryWindowsServices(args.df, args.cursor, args.pageSize || 50));

        // ── Custom Fields & Policy Queries ──
        case 'query_custom_fields':
          return this.result(await this.api.queryCustomFields(args.df, args.cursor, args.pageSize || 50));
        case 'query_custom_fields_detailed':
          return this.result(await this.api.queryCustomFieldsDetailed(args.df, args.cursor, args.pageSize || 50));
        case 'query_scoped_custom_fields':
          return this.result(await this.api.queryScopedCustomFields(args.df, args.cursor, args.pageSize || 50));
        case 'query_scoped_custom_fields_detailed':
          return this.result(await this.api.queryScopedCustomFieldsDetailed(args.df, args.cursor, args.pageSize || 50));
        case 'query_policy_overrides':
          return this.result(await this.api.queryPolicyOverrides(args.df, args.cursor, args.pageSize || 50));

        // ── Backup ──
        case 'query_backup_usage':
          return this.result(await this.api.queryBackupUsage(args.df, args.cursor, args.pageSize || 50));

        // ── Auto-paginating search tools ──
        case 'search_software':
          return this.result(await this.api.queryAllFiltered('/v2/queries/software', {
            df: args.df,
            filter: { text: args.name, fields: ['name', 'publisher'] },
            maxResults: args.maxResults || 50
          }));
        case 'search_os_patches':
          return this.result(await this.api.queryAllFiltered('/v2/queries/os-patches', {
            df: args.df,
            filter: { text: args.name, fields: ['name', 'kbNumber'] },
            maxResults: args.maxResults || 50
          }));
        case 'search_windows_services':
          return this.result(await this.api.queryAllFiltered('/v2/queries/windows-services', {
            df: args.df,
            filter: { text: args.name, fields: ['name', 'displayName'] },
            maxResults: args.maxResults || 50
          }));

        // ── Phase 2: Custom field writes ──
        case 'update_device_custom_fields': {
          if (!args.confirm) {
            return this.dryRun(`Would update custom fields on device id=${args.deviceId}.\nFields: ${JSON.stringify(args.fields, null, 2)}`);
          }
          return this.result(await this.api.updateDeviceCustomFields(args.deviceId, args.fields));
        }
        case 'update_org_custom_fields': {
          if (!args.confirm) {
            return this.dryRun(`Would update custom fields on organization id=${args.orgId}.\nFields: ${JSON.stringify(args.fields, null, 2)}`);
          }
          return this.result(await this.api.updateOrganizationCustomFields(args.orgId, args.fields));
        }

        // ── Phase 2: Ticketing ──
        case 'get_ticket_boards':
          return this.result(await this.api.getTicketBoards());
        case 'get_ticket_statuses':
          return this.result(await this.api.getTicketStatuses());
        case 'get_tickets':
          return this.result(this.applyDetail(await this.api.getTickets(args.boardId, args.pageSize || 25, args.lastCursorId), args, 'ticket'));
        case 'get_tickets_complete': {
          const data = await getTicketsComplete(this.api, {
            boardId: args.boardId,
            status: args.status,
            organizationId: args.organizationId,
            deviceId: args.deviceId,
            pageSize: args.pageSize,
            maxPages: args.maxPages,
            maxItems: args.maxItems,
          });
          return this.result(this.applyDetail(data, args, 'ticket'));
        }
        case 'get_ticket':
          return this.result(await this.api.getTicket(args.ticketId));
        case 'get_ticket_log':
          return this.result(await this.api.getTicketLog(args.ticketId));
        case 'create_ticket': {
          if (!args.confirm) {
            return this.dryRun(`Would create ticket.\nSummary: "${args.summary}"\nStatus: ${args.status || 'NEW'}\nPriority: ${args.priority || 'not set'}\nDevice: ${args.nodeId || 'none'}`);
          }
          const body: any = {
            subject: args.summary,
            status: args.status || 'NEW',
            ticketFormId: args.ticketFormId || 1
          };
          if (args.clientId !== undefined) body.clientId = args.clientId;
          if (args.description !== undefined) body.description = { public: true, body: args.description };
          if (args.priority !== undefined) body.priority = args.priority;
          if (args.severity !== undefined) body.severity = args.severity;
          if (args.type !== undefined) body.type = args.type;
          if (args.assignedAppUserId !== undefined) body.assignedAppUserId = args.assignedAppUserId;
          if (args.nodeId !== undefined) body.nodeId = args.nodeId;
          return this.result(await this.api.createTicket(body));
        }
        case 'update_ticket': {
          if (!args.confirm) {
            const changes: string[] = [];
            if (args.summary) changes.push(`summary → "${args.summary}"`);
            if (args.status) changes.push(`status → "${args.status}"`);
            if (args.priority) changes.push(`priority → "${args.priority}"`);
            if (args.severity) changes.push(`severity → "${args.severity}"`);
            if (args.type) changes.push(`type → "${args.type}"`);
            if (args.assignedAppUserId) changes.push(`assignedAppUserId → ${args.assignedAppUserId}`);
            if (args.comment) changes.push(`comment: "${args.comment}"`);
            return this.dryRun(`Would update ticket id=${args.ticketId}.\nChanges: ${changes.join(', ') || 'none specified'}`);
          }
          const ticketFields: any = {};
          if (args.summary !== undefined) ticketFields.summary = args.summary;
          if (args.status !== undefined) ticketFields.status = args.status;
          if (args.priority !== undefined) ticketFields.priority = args.priority;
          if (args.severity !== undefined) ticketFields.severity = args.severity;
          if (args.type !== undefined) ticketFields.type = args.type;
          if (args.assignedAppUserId !== undefined) ticketFields.assignedAppUserId = args.assignedAppUserId;
          if (args.locationId !== undefined) ticketFields.locationId = args.locationId;
          if (args.nodeId !== undefined) ticketFields.nodeId = args.nodeId;
          if (args.tags !== undefined) ticketFields.tags = args.tags;
          const comment = args.comment ? { public: true, body: args.comment } : undefined;
          return this.result(await this.api.updateTicket(args.ticketId, ticketFields, comment));
        }
        case 'add_ticket_comment': {
          if (!args.confirm) {
            return this.dryRun(`Would add comment to ticket id=${args.ticketId}.\nComment: "${args.comment}"`);
          }
          const isPublic = args.public !== false;
          return this.result(await this.api.addTicketComment(args.ticketId, args.comment, isPublic));
        }

        // ── Phase 3: Webhooks ──
        case 'get_webhook_config':
          return this.result(await this.api.getWebhookConfig());
        case 'set_webhook_config': {
          if (!args.confirm) {
            return this.dryRun(`Would configure webhook.\nURL: ${args.url}\nActivities: ${args.activities ? JSON.stringify(args.activities) : 'all'}`);
          }
          const body: any = { url: args.url };
          if (args.activities !== undefined) body.activities = args.activities;
          if (args.expand !== undefined) body.expand = args.expand;
          if (args.headers !== undefined) body.headers = args.headers;
          if (args.organizationIds !== undefined) body.organizationIds = args.organizationIds;
          return this.result(await this.api.setWebhookConfig(body));
        }
        case 'delete_webhook_config': {
          if (!args.confirm) {
            return this.dryRun(`Would delete the current webhook configuration.`);
          }
          return this.result(await this.api.deleteWebhookConfig());
        }

        // ── Phase 3: Polling queries ──
        case 'get_stale_devices':
          return this.result(await this.api.getStaleDevices(args.sinceHours || 48));
        case 'get_devices_pending_patches':
          return this.result(await this.api.getDevicesWithPendingPatches(args.status || 'PENDING'));
        case 'get_activities':
          return this.result(await this.api.getActivities({
            pageSize: args.pageSize || 50,
            after: args.after,
            olderThan: args.olderThan,
            newerThan: args.newerThan,
            type: args.type,
            df: args.df,
            user: args.user,
            status: args.status
          }));
        case 'export_readonly_audit':
          return this.result(await exportReadonlyAudit(this.api, args));

        // ── Phase 4: Script execution ──
        case 'list_automations':
          return this.result(await this.api.getAutomations(args.lang));
        case 'get_device_scripting_options':
          return this.result(await this.api.getDeviceScriptingOptions(args.deviceId, args.lang));
        case 'run_device_script': {
          if (!args.confirm) {
            const label = await this.deviceLabel(args.deviceId, resolved.device);
            return this.dryRun(`Would run script id=${args.scriptId} on device id=${args.deviceId} (${label}).\nType: ${args.type || 'SCRIPT'}\nRun as: ${args.runAs || 'SYSTEM'}\nParameters: ${args.parameters || 'none'}`);
          }
          return this.result(await this.api.runDeviceScript(args.deviceId, {
            type: args.type || 'SCRIPT',
            id: args.scriptId,
            runAs: args.runAs || 'SYSTEM',
            parameters: args.parameters
          }));
        }
        case 'run_device_powershell': {
          const runnerScriptId = this.security.policy.powershellRunnerScriptId;
          if (!runnerScriptId) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              'PowerShell runner is not configured. Create the saved NinjaOne runner script and set powershellRunnerScriptId in the command policy.',
            );
          }
          const command = typeof args.command === 'string' ? args.command.trim() : '';
          if (!command) {
            throw new McpError(ErrorCode.InvalidParams, 'PowerShell command must not be empty');
          }
          if (command.length > 16000) {
            throw new McpError(ErrorCode.InvalidParams, 'PowerShell command exceeds the 16000 character safety limit');
          }
          const timeoutSeconds = args.timeoutSeconds === undefined ? 120 : Number(args.timeoutSeconds);
          if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 900) {
            throw new McpError(ErrorCode.InvalidParams, 'timeoutSeconds must be an integer from 1 through 900');
          }
          if (!args.confirm) {
            const label = await this.deviceLabel(args.deviceId, resolved.device);
            return this.dryRun(
              `Would run PowerShell through saved runner script id=${runnerScriptId} on device id=${args.deviceId} (${label}).\n` +
              `Run as: system\nTimeout: ${timeoutSeconds} seconds\nCommand:\n${command}`,
            );
          }
          if (planApprovalRequired()) {
            // confirm:true is not approval. With no open device session this
            // creates a plan and stops — no runDeviceScript call is made.
            const ops = new OperationService(this.requireStore(), this.api, this.security);
            const chained = await ops.executeSessionCommand(Number(args.deviceId), { command, timeoutSeconds });
            if (chained.approvalRequired) {
              return this.result({
                code: 'APPROVAL_REQUIRED',
                approvalRequired: true,
                planId: chained.planId,
                planHash: chained.planHash,
                expiresAt: chained.expiresAt,
                deviceId: args.deviceId,
                message: chained.message,
              });
            }
            return this.result({
              operationId: chained.id,
              runId: chained.upstream_ref,
              sessionId: chained.sessionId,
              deviceId: args.deviceId,
              status: chained.status,
              commandsUsed: chained.commandsUsed,
              commandsRemaining: chained.commandsRemaining,
              commandSha256: createHash('sha256').update(command, 'utf8').digest('hex'),
              resultTool: 'get_powershell_result',
            });
          }
          const runId = randomUUID();
          const commandBase64 = Buffer.from(command, 'utf16le').toString('base64');
          const parameters = `${commandBase64} ${runId} ${timeoutSeconds}`;
          const submission = await this.api.runDeviceScript(args.deviceId, {
            type: 'SCRIPT',
            id: runnerScriptId,
            runAs: 'system',
            parameters,
          });
          return this.result({
            runId,
            deviceId: args.deviceId,
            runnerScriptId,
            timeoutSeconds,
            commandSha256: createHash('sha256').update(command, 'utf8').digest('hex'),
            submission,
            resultTool: 'get_powershell_result',
          });
        }
        case 'get_powershell_result': {
          const activitiesResponse = await this.api.getDeviceActivities(args.deviceId, 200);
          const activities = Array.isArray(activitiesResponse)
            ? activitiesResponse
            : activitiesResponse?.activities || [];
          const activity = activities.find((entry: any) => JSON.stringify(entry).includes(args.runId));
          if (!activity) {
            return this.result({
              deviceId: args.deviceId,
              runId: args.runId,
              complete: false,
              note: 'No recent activity containing this run ID was found. The command may still be queued or running.',
            });
          }
          const textValues: string[] = [];
          const collectText = (value: unknown, depth = 0): void => {
            if (depth > 8 || textValues.length > 500) return;
            if (typeof value === 'string') {
              textValues.push(value);
            } else if (Array.isArray(value)) {
              for (const item of value) collectText(item, depth + 1);
            } else if (value && typeof value === 'object') {
              for (const item of Object.values(value)) collectText(item, depth + 1);
            }
          };
          collectText(activity);
          let runnerResult: any = null;
          for (const value of textValues) {
            // Use the final result block so command output containing a marker-like
            // string cannot shadow the runner's authoritative machine result.
            const begin = value.lastIndexOf('S4X_RUNNER_RESULT_BEGIN');
            const end = value.lastIndexOf('S4X_RUNNER_RESULT_END');
            if (begin < 0 || end <= begin) continue;
            const payload = value.slice(begin + 'S4X_RUNNER_RESULT_BEGIN'.length, end).trim();
            try {
              runnerResult = JSON.parse(payload);
              break;
            } catch {
              runnerResult = null;
            }
          }

          if (runnerResult && Number(runnerResult.schemaVersion) >= 2) {
            const extractStream = (streamName: 'STDOUT' | 'STDERR'): string | null => {
              const beginMarker = `S4X_RUNNER_${streamName}_BEGIN:${args.runId}`;
              const endMarker = `S4X_RUNNER_${streamName}_END:${args.runId}`;
              for (const value of textValues) {
                const begin = value.lastIndexOf(beginMarker);
                if (begin < 0) continue;
                const contentStart = begin + beginMarker.length;
                const end = value.indexOf(endMarker, contentStart);
                if (end < contentStart) continue;
                const content = value
                  .slice(contentStart, end)
                  .replace(/^\r?\n/, '')
                  .replace(/\r?\n$/, '');
                return content === '(none)' ? '' : content;
              }
              return null;
            };

            const stdout = extractStream('STDOUT');
            const stderr = extractStream('STDERR');
            runnerResult = {
              ...runnerResult,
              stdout,
              stderr,
              streamsComplete: stdout !== null && stderr !== null,
            };
          }
          return this.result({
            deviceId: args.deviceId,
            runId: args.runId,
            complete: ['COMPLETED', 'CANCELLED', 'BLOCKED'].includes(activity.statusCode) || Boolean(activity.activityResult),
            runnerResult,
            activity,
          });
        }
        case 'get_script_result':
          return this.result(await this.api.getScriptResult(args.deviceId, args.activityId));

        // ── Phase 4: Policy management ──
        case 'get_policy':
          return this.result(await this.api.getPolicy(args.policyId));
        case 'assign_device_policy': {
          if (!args.confirm) {
            const label = await this.deviceLabel(args.deviceId, resolved.device);
            return this.dryRun(`Would assign policy id=${args.policyId} to device id=${args.deviceId} (${label}).`);
          }
          return this.result(await this.api.assignDevicePolicy(args.deviceId, args.policyId));
        }

        // ── Phase 4: Device approval ──
        case 'get_pending_devices':
          return this.result(await this.api.getPendingDevices());

        // ── Workspace: entity resolution, sync, history, filters, context ──
        case 'resolve_devices': {
          const resolver = this.requireResolver();
          const merged = this.applySavedFilter(args);
          const orgScope = merged.organization !== undefined
            ? (await resolver.resolveOrganization(merged.organization)).id
            : this.sessionOrg(sessionId) ?? undefined;
          const queries: Array<string | number> = merged.names !== undefined
            ? merged.names
            : (merged.name !== undefined ? [merged.name] : []);
          if (!Array.isArray(queries) || queries.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, 'resolve_devices requires name or names[]');
          }
          if (queries.length > 50) {
            throw new McpError(ErrorCode.InvalidParams, 'resolve_devices accepts at most 50 names per call');
          }
          const resolvedList: any[] = [];
          const failedList: any[] = [];
          for (const q of queries) {
            try {
              const r = await resolver.resolveDevice(q, { refresh: merged.refresh === true, orgId: orgScope });
              resolvedList.push(summarizeDevice(r.record, this.store?.orgName(r.orgId)));
            } catch (e) {
              failedList.push({ query: q, error: e instanceof Error ? e.message : String(e) });
            }
          }
          if (queries.length === 1 && resolvedList.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, failedList[0].error);
          }
          return this.result({ resolved: resolvedList, failed: failedList });
        }
        case 'resolve_organizations': {
          const resolver = this.requireResolver();
          const queries: Array<string | number> = args.names !== undefined
            ? args.names
            : (args.name !== undefined ? [args.name] : []);
          if (!Array.isArray(queries) || queries.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, 'resolve_organizations requires name or names[]');
          }
          if (queries.length > 50) {
            throw new McpError(ErrorCode.InvalidParams, 'resolve_organizations accepts at most 50 names per call');
          }
          const resolvedList: any[] = [];
          const failedList: any[] = [];
          for (const q of queries) {
            try {
              const r = await resolver.resolveOrganization(q, { refresh: args.refresh === true });
              resolvedList.push(summarizeOrganization(r.record));
            } catch (e) {
              failedList.push({ query: q, error: e instanceof Error ? e.message : String(e) });
            }
          }
          if (queries.length === 1 && resolvedList.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, failedList[0].error);
          }
          return this.result({ resolved: resolvedList, failed: failedList });
        }
        case 'resolve_locations': {
          const resolver = this.requireResolver();
          const orgScope = args.organization !== undefined
            ? (await resolver.resolveOrganization(args.organization)).id
            : this.sessionOrg(sessionId) ?? undefined;
          const queries: Array<string | number> = args.names !== undefined
            ? args.names
            : (args.name !== undefined ? [args.name] : []);
          if (!Array.isArray(queries) || queries.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, 'resolve_locations requires name or names[]');
          }
          const resolvedList: any[] = [];
          const failedList: any[] = [];
          for (const q of queries.slice(0, 50)) {
            try {
              const r = await resolver.resolveLocation(q, { refresh: args.refresh === true, orgId: orgScope });
              resolvedList.push({ id: r.id, organizationId: r.orgId, name: r.label });
            } catch (e) {
              failedList.push({ query: q, error: e instanceof Error ? e.message : String(e) });
            }
          }
          if (queries.length === 1 && resolvedList.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, failedList[0].error);
          }
          return this.result({ resolved: resolvedList, failed: failedList });
        }
        case 'resolve_policies': {
          const resolver = this.requireResolver();
          const queries: Array<string | number> = args.names !== undefined
            ? args.names
            : (args.name !== undefined ? [args.name] : []);
          if (!Array.isArray(queries) || queries.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, 'resolve_policies requires name or names[]');
          }
          const resolvedList: any[] = [];
          const failedList: any[] = [];
          for (const q of queries.slice(0, 50)) {
            try {
              const r = await resolver.resolvePolicy(q, { refresh: args.refresh === true });
              resolvedList.push({ id: r.id, name: r.label });
            } catch (e) {
              failedList.push({ query: q, error: e instanceof Error ? e.message : String(e) });
            }
          }
          if (queries.length === 1 && resolvedList.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, failedList[0].error);
          }
          return this.result({ resolved: resolvedList, failed: failedList });
        }
        case 'sync_entities': {
          const resolver = this.requireResolver();
          const reports = await resolver.syncEntities(args.entities);
          this.recordInvalidations(reports);
          // trackedFields is the honest diff contract: entity_changes only
          // observes the allowlisted columns below — nothing else is tracked.
          return this.result({ reports, trackedFields: PERSIST_ALLOWLISTS, counts: this.requireStore().counts() });
        }
        case 'get_entity_changes': {
          const store = this.requireStore();
          const changes = store.getChanges({
            entityType: args.entityType,
            entityId: args.entityId,
            field: args.field,
            since: this.parseSince(args.since),
            limit: args.limit,
          });
          const enriched = changes.map((c) => ({
            ...c,
            entity_name: this.entityNameFor(c.entity_type, c.entity_id),
            detected_at_iso: new Date(c.detected_at).toISOString(),
          }));
          return this.result({ changes: enriched, trackedFields: PERSIST_ALLOWLISTS });
        }
        case 'get_operation_journal':
          return this.result({
            journal: this.requireStore().getJournal({
              since: this.parseSince(args.since),
              tool: args.tool,
              limit: args.limit,
            }),
          });
        // ── M5A harness-neutral operation contract (plan §6) ────────────
        case 'list_runbooks':
          return this.contract({
            ok: true,
            runbooks: listRunbooks({ category: args.category, query: args.query }).map(summarizeRunbook),
          });
        case 'get_runbook': {
          try {
            const rb = getRunbook(String(args.id), args.version === undefined ? undefined : Number(args.version));
            return this.contract({
              ok: true,
              runbook: {
                ...summarizeRunbook(rb),
                params: rb.params,
                sideEffects: rb.sideEffects,
                affectedScope: rb.affectedScope,
                outputLimits: rb.outputLimits,
                retry: rb.retry,
                resultSchema: rb.resultSchema,
                preconditions: rb.preconditions,
                postconditions: rb.postconditions,
                recovery: rb.recovery,
                review: rb.review,
                script: rb.script,
              },
            });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'select_devices': {
          try {
            const sel = new SelectionService(this.requireStore(), this.security);
            const created = sel.create({
              orgId: args.orgId === undefined ? undefined : Number(args.orgId),
              offline: args.offline === undefined ? undefined : Boolean(args.offline),
              q: args.q === undefined ? undefined : String(args.q),
              deviceIds: Array.isArray(args.deviceIds) ? args.deviceIds.map(Number) : undefined,
            }, this.security.principal?.profile ?? this.security.profile);
            return this.contract({
              ok: true,
              ...created,
              summary: `Frozen selection: ${created.memberCount} device(s)${created.orgName ? ` in ${created.orgName}` : ''} — reference by id; membership cannot drift.`,
              nextAction: 'create_plan with selectionId',
            });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'get_selection': {
          try {
            const sel = new SelectionService(this.requireStore(), this.security);
            const found = sel.describe(String(args.selectionId));
            if (!found) return this.contract({ ok: false, code: 'selection_not_found', message: `Selection ${args.selectionId} not found` });
            return this.contract({ ok: true, ...found });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'list_selections': {
          try {
            const sel = new SelectionService(this.requireStore(), this.security);
            return this.contract({ ok: true, selections: sel.list(args.limit === undefined ? undefined : Number(args.limit)) });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'create_plan': {
          try {
            const ops = new OperationService(this.requireStore(), this.api, this.security);
            const hasSelection = typeof args.selectionId === 'string' && args.selectionId.length > 0;
            if (!hasSelection && args.deviceId === undefined) {
              return this.contract({ ok: false, code: 'invalid_params', message: 'create_plan requires deviceId or selectionId' });
            }
            const deviceId = Number(args.deviceId);
            const plan = ops.createPlan({
              operation: 'run_device_powershell',
              targetType: hasSelection ? 'selection' : 'device',
              targetId: hasSelection ? 0 : deviceId,
              selectionId: hasSelection ? String(args.selectionId) : undefined,
              canarySize: args.canarySize === undefined ? undefined : Number(args.canarySize),
              args: {
                command: args.command,
                runbookId: args.runbookId,
                runbookVersion: args.runbookVersion,
                params: args.params,
                timeoutSeconds: args.timeoutSeconds,
              },
            });
            return this.contract({
              ok: true,
              planId: plan.id,
              planHash: plan.planHash,
              expiresAt: plan.expiresAt,
              deviceId: hasSelection ? null : deviceId,
              targetCount: plan.targetCount ?? null,
              canarySize: args.canarySize ?? null,
              runbook: plan.runbook ?? null,
              reviewUrl: this.reviewUrl(String(plan.id)),
              summary: hasSelection
                ? `Batch plan created for ${plan.targetCount} frozen device(s) — nothing executed. Human approval required.`
                : `Plan created — nothing executed. Human approval required.`,
              nextAction: 'Have a human approve at reviewUrl, then call dispatch_plan',
            });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'dispatch_plan': {
          try {
            const ops = new OperationService(this.requireStore(), this.api, this.security);
            const op = await ops.dispatchPlan(String(args.planId));
            return this.contract({
              ok: true,
              operationId: op.id,
              status: op.status,
              deviceId: op.target_id,
              summary: `Dispatched — poll get_operation for the receipt.`,
              nextAction: 'get_operation',
            });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'get_operation': {
          try {
            const ops = new OperationService(this.requireStore(), this.api, this.security);
            const op = await ops.reconcile(String(args.operationId));
            if (!op) return this.contract({ ok: false, code: 'operation_not_found', message: `Operation ${args.operationId} not found` });
            const result = op.result as Record<string, unknown> | null;
            const isBatch = op.target_type === 'selection';
            const summary: Record<string, unknown> = {
              id: op.id, status: op.status, operation: op.operation,
              deviceId: isBatch ? null : op.target_id, device: isBatch ? op.selection_label : op.device_label,
              planId: op.plan_id, runbook: op.runbook_id ? { id: op.runbook_id, version: op.runbook_version } : null,
              createdAt: op.created_at, updatedAt: op.updated_at,
              exitCode: result?.exitCode ?? null,
              verified: op.status === 'verified',
            };
            if (isBatch) {
              // Parent rollup conserves the frozen count — list_operation_targets for detail.
              summary.targets = op.targets;
              summary.nextAction = op.status === 'canary_paused' ? 'canary paused — review in UI' : 'list_operation_targets';
            }
            if (result?.parsed) summary.parsed = result.parsed;
            if ((args.detail ?? 'summary') === 'full') {
              summary.result = result;
              summary.events = op.events;
            } else {
              summary.truncated = { stdoutChars: typeof result?.stdout === 'string' ? result.stdout.length : 0 };
            }
            return this.contract({ ok: true, operation: summary });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'list_operations': {
          try {
            const ops = new OperationService(this.requireStore(), this.api, this.security);
            const rows = ops.listOperations({
              status: args.status,
              sinceMs: args.since === undefined ? undefined : this.parseSince(args.since),
              limit: args.limit,
              cursor: args.cursor === undefined ? undefined : Number(args.cursor),
            });
            const nextCursor = rows.length > 0 ? Number(rows[rows.length - 1]!._seq) : null;
            return this.contract({ ok: true, operations: rows, nextCursor });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'cancel_operation': {
          try {
            const ops = new OperationService(this.requireStore(), this.api, this.security);
            const outcome = ops.cancelOperation(String(args.operationId));
            return this.contract({ ok: outcome.code !== 'already_terminal', ...outcome });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'generate_report': {
          try {
            const window = resolveWindow({
              sinceDays: args.sinceDays === undefined ? undefined : Number(args.sinceDays),
              since: args.since === undefined ? undefined : String(args.since),
              until: args.until === undefined ? undefined : String(args.until),
            });
            const report = args.reportType === 'org'
              ? buildOrgReport(this.requireStore(), window, Number(args.orgId))
              : buildOperationsReport(this.requireStore(), window, args.orgId === undefined ? undefined : Number(args.orgId));
            if (args.format === 'markdown') {
              return this.contract({ ok: true, window: report.window, summary: report.summary, markdown: args.reportType === 'org' ? renderOrgReportMarkdown(report) : renderReportMarkdown(report) });
            }
            return this.contract({ ok: true, ...report });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'list_operation_targets': {
          try {
            const ops = new OperationService(this.requireStore(), this.api, this.security);
            const page = ops.listTargets(String(args.operationId), {
              status: args.status === undefined ? undefined : String(args.status),
              cursor: args.cursor === undefined ? undefined : Number(args.cursor),
              limit: args.limit === undefined ? undefined : Number(args.limit),
            });
            return this.contract({ ok: true, ...page });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'get_infrastructure_summary': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            return this.contract({ ok: true, ...new InfraService(this.requireStore()).orgSummary(Number(orgId)) });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'list_infrastructure_entities': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            const infra = new InfraService(this.requireStore());
            if (args.asOf !== undefined) {
              const asOfMs = Date.parse(String(args.asOf));
              if (!Number.isFinite(asOfMs)) return this.contractError(new OpError('invalid_params', 'asOf must be an ISO date/datetime'));
              return this.contract({ ok: true, ...infra.listEntitiesAsOf(Number(orgId), asOfMs, {
                category: args.category === undefined ? undefined : String(args.category),
                q: args.q === undefined ? undefined : String(args.q),
                limit: args.limit === undefined ? undefined : Number(args.limit),
              }) });
            }
            const page = infra.listEntities(Number(orgId), {
              category: args.category === undefined ? undefined : String(args.category),
              namespace: args.namespace === undefined ? undefined : String(args.namespace),
              status: args.status === undefined ? undefined : String(args.status),
              q: args.q === undefined ? undefined : String(args.q),
              limit: args.limit === undefined ? undefined : Number(args.limit),
              cursor: args.cursor === undefined ? undefined : Number(args.cursor),
            });
            return this.contract({ ok: true, ...page });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'get_infrastructure_entity': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            const detail = new InfraService(this.requireStore()).getEntity(Number(orgId), String(args.entityId));
            if (!detail) return this.contract({ ok: false, code: 'entity_not_found', summary: `Entity ${String(args.entityId)} not found` });
            return this.contract({ ok: true, ...detail });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'get_infrastructure_coverage': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            return this.contract({ ok: true, ...new InfraService(this.requireStore()).getCoverage(Number(orgId)) });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'get_infrastructure_changes': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            const w = resolveWindow({
              sinceDays: args.sinceDays === undefined ? undefined : Number(args.sinceDays),
              since: args.since === undefined ? undefined : String(args.since),
              until: args.until === undefined ? undefined : String(args.until),
            });
            const out = new InfraService(this.requireStore()).getChanges(Number(orgId), {
              since: w.sinceMs,
              until: w.untilMs,
              category: args.category === undefined ? undefined : String(args.category),
              limit: args.limit === undefined ? undefined : Number(args.limit),
            });
            return this.contract({ ok: true, ...out });
          } catch (e) {
            return this.contractError(e);
          }
        }
        case 'get_endpoint_infrastructure': {
          try {
            const r = await this.requireResolver().resolveDevice(args.device);
            const store = this.requireStore();
            const row = store.getDeviceById(Number(r.id));
            return this.contract({ ok: true, ...new InfraService(store).endpointContext(Number(row?.org_id ?? r.orgId ?? 0), Number(r.id)) });
          } catch (e) {
            return this.contractError(e);
          }
        }

        // ── REVIEW-1: Review Center — local collaboration state only ──
        // These handlers never touch this.api; they read/write retained
        // review records. Provenance is recorded honestly: harness
        // submissions are 'reported' context or 'delegated' instructions,
        // never fabricated direct-human actions.
        case 'get_review_digest': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            return this.contract({ ok: true, ...new ReviewService(this.requireStore()).digest(Number(orgId)) });
          } catch (e) { return this.contractError(e); }
        }
        case 'list_review_items': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            const page = new ReviewService(this.requireStore()).listItems(Number(orgId), {
              type: args.type === undefined ? undefined : String(args.type),
              workflow: args.workflow === undefined ? undefined : String(args.workflow),
              disposition: args.disposition === undefined ? undefined : String(args.disposition),
              assessment: args.assessment === undefined ? undefined : String(args.assessment),
              category: args.category === undefined ? undefined : String(args.category),
              q: args.q === undefined ? undefined : String(args.q),
              limit: args.limit === undefined ? undefined : Number(args.limit),
              cursor: args.cursor === undefined ? undefined : Number(args.cursor),
            });
            return this.contract({ ok: true, ...page });
          } catch (e) { return this.contractError(e); }
        }
        case 'get_review_item': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            const detail = new ReviewService(this.requireStore()).getItem(Number(orgId), String(args.itemId), args.includeHistory !== false);
            return this.contract({ ok: true, ...detail });
          } catch (e) { return this.contractError(e); }
        }
        case 'list_review_questions': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            return this.contract({ ok: true, questions: new ReviewService(this.requireStore()).listQuestions(Number(orgId), args.status === undefined ? undefined : String(args.status)) });
          } catch (e) { return this.contractError(e); }
        }
        case 'list_org_annotations': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            return this.contract({ ok: true, annotations: new ReviewService(this.requireStore()).listOrgAnnotations(Number(orgId)) });
          } catch (e) { return this.contractError(e); }
        }
        case 'propose_review_item': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            const out = new ReviewService(this.requireStore()).proposeItem({
              orgId: Number(orgId),
              connectionId: this.connectionId,
              itemType: String(args.itemType) as never,
              category: args.category === undefined ? undefined : String(args.category),
              title: String(args.title ?? ''),
              summary: args.summary === undefined ? undefined : String(args.summary),
              rationale: args.rationale === undefined ? undefined : String(args.rationale),
              consequence: args.consequence === undefined ? undefined : String(args.consequence),
              knownsUnknowns: args.knownsUnknowns === undefined ? undefined : String(args.knownsUnknowns),
              impact: args.impact === undefined ? undefined : String(args.impact),
              urgency: args.urgency === undefined ? undefined : String(args.urgency),
              severity: args.severity === undefined ? undefined : String(args.severity),
              confidence: args.confidence === undefined ? undefined : String(args.confidence),
              subject: args.subject === undefined ? undefined : args.subject as Record<string, unknown>,
              evidence: args.evidence === undefined ? undefined : args.evidence as never,
              questions: args.questions === undefined ? undefined : args.questions as never,
              sourceKind: 'harness',
              sourceId: args.sourceId === undefined ? undefined : String(args.sourceId),
              sourceVersion: args.sourceVersion === undefined ? undefined : String(args.sourceVersion),
              actor: `mcp:${this.security.profile}`,
              provenance: 'reported',
              idempotencyKey: args.idempotencyKey === undefined ? undefined : String(args.idempotencyKey),
            });
            return this.contract({ ok: true, ...out });
          } catch (e) { return this.contractError(e); }
        }
        case 'revise_review_item': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            const out = new ReviewService(this.requireStore()).reviseItem(Number(orgId), String(args.itemId), Number(args.expectedRevision), {
              title: args.title === undefined ? undefined : String(args.title),
              summary: args.summary === undefined ? undefined : String(args.summary),
              rationale: args.rationale === undefined ? undefined : String(args.rationale),
              consequence: args.consequence === undefined ? undefined : String(args.consequence),
              knownsUnknowns: args.knownsUnknowns === undefined ? undefined : String(args.knownsUnknowns),
              impact: args.impact === undefined ? undefined : String(args.impact),
              urgency: args.urgency === undefined ? undefined : String(args.urgency),
              severity: args.severity === undefined ? undefined : String(args.severity),
              confidence: args.confidence === undefined ? undefined : String(args.confidence),
            }, { kind: 'harness', name: `mcp:${this.security.profile}`, provenance: 'reported' });
            return this.contract({ ok: true, ...out });
          } catch (e) { return this.contractError(e); }
        }
        case 'ask_review_question': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            const out = new ReviewService(this.requireStore()).addQuestion(Number(orgId), {
              itemId: args.itemId === undefined ? undefined : String(args.itemId),
              question: String(args.question ?? ''),
              whyItMatters: args.whyItMatters === undefined ? undefined : String(args.whyItMatters),
              answerType: args.answerType === undefined ? undefined : String(args.answerType),
            }, { kind: 'harness', name: `mcp:${this.security.profile}` });
            return this.contract({ ok: true, question: out });
          } catch (e) { return this.contractError(e); }
        }
        case 'answer_review_question': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            const out = new ReviewService(this.requireStore()).answerQuestion(Number(orgId), String(args.questionId), {
              answerText: String(args.answer ?? ''),
              normalized: args.normalized === undefined ? undefined : args.normalized as Record<string, unknown>,
              actorKind: 'harness',
              actor: args.actor ? `mcp:${this.security.profile}:${String(args.actor).trim().slice(0, 80)}` : `mcp:${this.security.profile}`,
              provenance: 'reported',
            }, args.idempotencyKey === undefined ? undefined : String(args.idempotencyKey));
            return this.contract({ ok: true, ...out });
          } catch (e) { return this.contractError(e); }
        }
        case 'add_org_annotation': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            const out = new ReviewService(this.requireStore()).addOrgAnnotation(Number(orgId), {
              annotationType: String(args.annotationType),
              subject: args.subject === undefined ? undefined : args.subject as Record<string, unknown>,
              text: String(args.text ?? ''),
              attribution: 'reported_human',
              actor: `mcp:${this.security.profile}`,
              sourceNote: args.sourceNote === undefined ? undefined : String(args.sourceNote),
            });
            return this.contract({ ok: true, annotation: out });
          } catch (e) { return this.contractError(e); }
        }
        case 'record_review_decision': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            const out = new ReviewService(this.requireStore()).recordDecision(Number(orgId), String(args.itemId), {
              disposition: String(args.disposition) as never,
              rationale: args.rationale === undefined ? undefined : String(args.rationale),
              owner: args.owner === undefined ? undefined : String(args.owner),
              scopeNote: args.scopeNote === undefined ? undefined : String(args.scopeNote),
              reviewDueAt: args.reviewDueAt === undefined ? undefined : Number(args.reviewDueAt),
              evidenceBasis: args.evidenceBasis,
              actorKind: 'harness',
              actor: `mcp:${this.security.profile}`,
              provenance: 'delegated',
              canonicalItemId: args.canonicalItemId === undefined ? undefined : String(args.canonicalItemId),
            }, args.idempotencyKey === undefined ? undefined : String(args.idempotencyKey));
            return this.contract({ ok: true, ...out });
          } catch (e) { return this.contractError(e); }
        }
        case 'suppress_review': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            const out = new ReviewService(this.requireStore()).addSuppression(Number(orgId), {
              fingerprint: args.fingerprint === undefined ? undefined : String(args.fingerprint),
              ruleId: args.ruleId === undefined ? undefined : String(args.ruleId),
              itemId: args.itemId === undefined ? undefined : String(args.itemId),
              reason: String(args.reason ?? ''),
              actor: `mcp:${this.security.profile}`,
              expiresAt: args.expiresAt === undefined ? undefined : Number(args.expiresAt),
            });
            return this.contract({ ok: true, suppression: out });
          } catch (e) { return this.contractError(e); }
        }
        case 'link_review_operation': {
          try {
            const orgId = (await this.requireResolver().resolveOrganization(args.org)).id;
            const out = new ReviewService(this.requireStore()).linkOperation(Number(orgId), String(args.itemId), {
              operationId: args.operationId === undefined ? undefined : String(args.operationId),
              planId: args.planId === undefined ? undefined : String(args.planId),
              linkKind: String(args.linkKind),
              actor: `mcp:${this.security.profile}`,
            });
            return this.contract({ ok: true, link: out });
          } catch (e) { return this.contractError(e); }
        }
        case 'save_filter': {
          const store = this.requireStore();
          if (typeof args.name !== 'string' || !args.name.trim()) {
            throw new McpError(ErrorCode.InvalidParams, 'save_filter requires a non-empty name');
          }
          if (!args.params || typeof args.params !== 'object' || Array.isArray(args.params)) {
            throw new McpError(ErrorCode.InvalidParams, 'save_filter requires params to be an object');
          }
          store.saveFilter(args.name.trim(), String(args.entityType), args.params);
          return this.result({ saved: true, name: args.name.trim(), entityType: args.entityType });
        }
        case 'list_saved_filters':
          return this.result({ filters: this.requireStore().listFilters(args.entityType) });
        case 'delete_saved_filter': {
          if (typeof args.name !== 'string' || !args.name.trim()) {
            throw new McpError(ErrorCode.InvalidParams, 'delete_saved_filter requires a name');
          }
          const deleted = this.requireStore().deleteFilter(args.name.trim());
          return this.result({ deleted, name: args.name.trim() });
        }
        case 'set_context': {
          if (args.organization === null) {
            this.sessionOrgs.delete(sessionId);
            return this.result({ organizationId: null, note: 'Session organization scope cleared' });
          }
          if (args.organization === undefined) {
            throw new McpError(ErrorCode.InvalidParams, 'Provide an organization name/ID, or null to clear the scope');
          }
          const r = await this.requireResolver().resolveOrganization(args.organization);
          this.sessionOrgs.set(sessionId, r.id);
          return this.result({
            organizationId: r.id,
            organizationName: r.label,
            note: 'Session organization scope set; org-capable tools default to it when their org param is omitted',
          });
        }
        case 'get_context': {
          const sessionOrgId = this.sessionOrg(sessionId);
          return this.result({
            organizationId: sessionOrgId,
            organizationName: sessionOrgId !== null ? this.requireStore().orgName(sessionOrgId) : null,
            connectionId: this.connectionId,
            cache: this.store ? this.store.counts() : null,
            syncState: this.store
              ? ['devices', 'organizations', 'policies', 'locations'].map((t) => {
                  const state = this.store!.syncState(t);
                  return { entityType: t, lastSyncAt: state?.last_sync_at ?? null, lastSyncIso: state ? new Date(state.last_sync_at).toISOString() : null, itemCount: state?.item_count ?? 0 };
                })
              : null,
          });
        }

        // ── M4.5: snapshot capture / compare / pin (read-only upstream) ──
        case 'capture_device_snapshot': {
          const resolver = this.requireResolver();
          const dev = await resolver.resolveDevice(args.device, { orgId: this.sessionOrg(sessionId) ?? undefined });
          const svc = new SnapshotService(this.requireStore(), this.api, this.security.profile);
          const r = await svc.capture({
            deviceId: dev.id,
            profile: args.profile,
            resources: args.resources,
            kind: 'on_demand',
          });
          return this.result(r);
        }
        case 'get_capture_status': {
          const run = new SnapshotService(this.requireStore(), this.api).getRun(String(args.jobId));
          if (!run) throw new McpError(ErrorCode.InvalidParams, 'capture run not found');
          return this.result({ run });
        }
        case 'list_device_snapshots': {
          const resolver = this.requireResolver();
          const dev = await resolver.resolveDevice(args.device, { orgId: this.sessionOrg(sessionId) ?? undefined });
          return this.result({
            snapshots: new SnapshotService(this.requireStore(), this.api).listSnapshots(dev.id, {
              since: this.parseSince(args.since),
              until: this.parseSince(args.until),
              limit: args.limit,
            }),
          });
        }
        case 'get_device_snapshot': {
          const svc = new SnapshotService(this.requireStore(), this.api);
          const s = svc.getSnapshot(String(args.snapshotId));
          if (!s) throw new McpError(ErrorCode.InvalidParams, 'snapshot not found');
          if (args.detail === 'full') {
            s.observations = (s.resources as any[])
              .filter((r) => r.observation_id)
              .map((r) => svc.getObservation(r.observation_id, 'summary'));
          }
          return this.result({ snapshot: s });
        }
        case 'compare_device_snapshots': {
          const svc = new SnapshotService(this.requireStore(), this.api);
          const result = svc.compare(String(args.baselineId), String(args.comparisonId));
          if (result.error) throw new McpError(ErrorCode.InvalidParams, result.error);
          if (Array.isArray(args.resources) && args.resources.length) {
            result.resources = result.resources.filter((r: any) => args.resources.includes(r.resource));
          }
          const limit = Number(args.limit) || 20;
          result.resources = result.resources.slice(0, limit);
          return this.result({ comparison: result });
        }
        case 'get_snapshot_resource': {
          const o = new SnapshotService(this.requireStore(), this.api).getObservation(
            String(args.observationId),
            args.detail === 'full' ? 'full' : 'summary',
          );
          if (!o) throw new McpError(ErrorCode.InvalidParams, 'observation not found');
          return this.result({ observation: o });
        }
        case 'get_device_change_summary': {
          const resolver = this.requireResolver();
          const dev = await resolver.resolveDevice(args.device, { orgId: this.sessionOrg(sessionId) ?? undefined });
          const since = this.parseSince(args.since) ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
          return this.result(
            new SnapshotService(this.requireStore(), this.api).changeSummary(dev.id, since),
          );
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `API call failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async searchDevicesByName(searchName: string, limit: number, sessionId: string = 'stdio') {
    if (this.resolver) {
      const rows = await this.resolver.searchDevices(searchName, {
        limit,
        orgId: this.sessionOrg(sessionId) ?? undefined,
      });
      return {
        searchTerm: searchName,
        totalFound: rows.length,
        devices: rows.map((d) => {
          const orgId = typeof d.org_id === 'number' ? d.org_id : Number(d.org_id);
          return summarizeDevice(d, this.store?.orgName(Number.isFinite(orgId) ? orgId : null));
        }),
      };
    }

    // Fallback when the local store is unavailable: single-page API scan.
    const devices = await this.api.getDevices(undefined, 200);
    const filtered = devices
      .filter((device: any) =>
        device.systemName?.toLowerCase().includes(searchName.toLowerCase()) ||
        device.displayName?.toLowerCase().includes(searchName.toLowerCase())
      )
      .slice(0, limit)
      .map((d: any) => ({
        id: d.id,
        systemName: d.systemName,
        displayName: d.displayName,
        nodeClass: d.nodeClass,
        offline: d.offline,
        organizationId: d.organizationId,
        lastContact: d.lastContact
      }));

    return {
      searchTerm: searchName,
      totalFound: filtered.length,
      devices: filtered
    };
  }

  private async findWindows11Devices(limit: number) {
    // Use the OS query endpoint to find Windows 11 in one call instead of N+1 device lookups
    const osData = await this.api.queryOperatingSystems(undefined, undefined, 500);
    const results: any[] = osData?.results || [];
    const windows11Devices = results
      .filter((r: any) => r.name?.includes('Windows 11'))
      .slice(0, limit)
      .map((r: any) => ({
        deviceId: r.deviceId,
        name: r.name,
        buildNumber: r.buildNumber,
        releaseId: r.releaseId,
        architecture: r.architecture,
        lastReboot: r.lastReboot
      }));

    return {
      totalFound: windows11Devices.length,
      devices: windows11Devices
    };
  }

  async runStdio() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('NinjaONE MCP server running on STDIO transport');
  }

}

/**
 * Main entry point. Network transports are intentionally unsupported.
 */
async function main() {
  const mode = (process.env.MCP_MODE || 'stdio').toLowerCase();
  if (mode !== 'stdio') {
    throw new Error(`Unsupported MCP_MODE "${mode}". This build supports local stdio transport only.`);
  }

  const server = new NinjaOneMCPServer();

  try {
    await server.runStdio();
  } catch (error) {
    console.error('Server startup failed:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Start the server only when this file is the entry point — importing the
// module (e.g. from tests) must not spawn the stdio loop as a side effect.
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isMainModule = invokedPath !== '' && import.meta.url === pathToFileURL(invokedPath).href;
if (isMainModule) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
