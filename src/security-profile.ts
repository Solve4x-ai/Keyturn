import { readFileSync } from 'fs';

export type AuthProfile = 'reporting' | 'command';

export interface LocalPolicy {
  allowedOrganizationIds: number[];
  defaultOrganizationId: number | null;
  blockedActions: string[];
  ticketWritesEnabled: boolean;
  deviceManagementEnabled: boolean;
  administrativeWritesEnabled: boolean;
  deviceScriptsEnabled: boolean;
  powershellRunnerScriptId: number | null;
  softwareDeploymentEnabled: boolean;
  remoteControlEnabled: boolean;
  destructiveOperationsEnabled: boolean;
  /**
   * REVIEW-1: explicit app grant for local review-record writes (proposals,
   * answers, annotations, decisions, suppressions). Local collaboration
   * state only — never endpoint capability. Default false: an unset grant
   * is read-only.
   */
  reviewWritesEnabled: boolean;
  /**
   * Explicit grant for set_health_status plans: Keyturn may write one
   * NinjaOne Health Status custom field per approved plan. Default false.
   */
  healthWritebackEnabled: boolean;
  /** Chained PowerShell session bounds; omitted → built-in defaults apply. */
  powershellSessionTtlSeconds?: number | undefined;
  powershellSessionMaxCommands?: number | undefined;
}

/**
 * The principal this process runs as. Authority derives from the principal
 * (env-configured credential kind), never from a request-body profile string.
 * reporting → client_credentials grant; command → native PKCE user grant.
 * One process = one principal; the two never share or fall back.
 */
export type CredentialKind = 'client_credentials' | 'native_pkce';

export interface Principal {
  profile: AuthProfile;
  credentialKind: CredentialKind;
}

export interface RuntimeSecurity {
  profile: AuthProfile;
  principal: Principal;
  policy: LocalPolicy;
}

type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

const SAFE_DEFAULT_POLICY: LocalPolicy = {
  allowedOrganizationIds: [],
  defaultOrganizationId: null,
  blockedActions: [],
  ticketWritesEnabled: false,
  deviceManagementEnabled: false,
  administrativeWritesEnabled: false,
  deviceScriptsEnabled: false,
  powershellRunnerScriptId: null,
  softwareDeploymentEnabled: false,
  remoteControlEnabled: false,
  destructiveOperationsEnabled: false,
  reviewWritesEnabled: false,
  healthWritebackEnabled: false,
};

export const REPORTING_READ_TOOLS = new Set([
  'get_auth_profile',
  'find_endpoint',
  'describe_endpoint',
  'ninjaone_navigate',
  'get_devices',
  'get_devices_complete',
  'list_regions',
  'get_device',
  'get_organizations',
  'get_alerts',
  'get_device_activities',
  'get_device_software',
  'get_device_dashboard_url',
  'search_devices_by_name',
  'find_windows11_devices',
  'get_organization',
  'get_organization_locations',
  'get_organization_policies',
  'get_alert',
  'get_device_alerts',
  'get_end_users',
  'get_end_user',
  'get_technicians',
  'get_technician',
  'get_contacts',
  'get_contact',
  'get_device_policy_overrides',
  'get_policies',
  'query_antivirus_status',
  'query_antivirus_threats',
  'query_computer_systems',
  'query_device_health',
  'query_operating_systems',
  'query_logged_on_users',
  'query_processors',
  'query_disks',
  'query_volumes',
  'query_network_interfaces',
  'query_raid_controllers',
  'query_raid_drives',
  'query_software',
  'query_os_patches',
  'query_software_patches',
  'query_os_patch_installs',
  'query_software_patch_installs',
  'query_windows_services',
  'query_custom_fields',
  'query_custom_fields_detailed',
  'query_scoped_custom_fields',
  'query_scoped_custom_fields_detailed',
  'query_policy_overrides',
  'query_backup_usage',
  'search_software',
  'search_os_patches',
  'search_windows_services',
  'get_ticket_boards',
  'get_ticket_statuses',
  'get_tickets',
  'get_tickets_complete',
  'get_ticket',
  'get_ticket_log',
  'get_webhook_config',
  'get_stale_devices',
  'get_devices_pending_patches',
  'get_activities',
  'list_automations',
  'get_script_result',
  'get_policy',
  'get_pending_devices',
  'export_readonly_audit',
  'resolve_devices',
  'resolve_organizations',
  'resolve_locations',
  'resolve_policies',
  'sync_entities',
  'get_entity_changes',
  'get_operation_journal',
  'list_runbooks',
  'get_runbook',
  'get_operation',
  'list_operations',
  'list_operation_targets',
  'generate_report',
  'select_devices',
  'get_selection',
  'list_selections',
  'save_filter',
  'list_saved_filters',
  'delete_saved_filter',
  'set_context',
  'get_context',
  'get_infrastructure_summary',
  'list_infrastructure_entities',
  'get_infrastructure_entity',
  'get_infrastructure_coverage',
  'get_infrastructure_changes',
  'get_endpoint_infrastructure',
  'get_review_digest',
  'list_review_items',
  'get_review_item',
  'list_review_questions',
  'list_org_annotations',
]);

/** Knowledge base and global custom fields — read-only, both profiles. */
export const KNOWLEDGE_READ_TOOLS = new Set([
  'list_kb_articles',
  'get_kb_article',
  'get_system_custom_fields',
]);

/**
 * Proposes a set_health_status plan. Command profile only, and only when the
 * policy grants healthWritebackEnabled; the write itself still needs approval.
 */
export const HEALTH_PLAN_TOOLS = new Set(['propose_health_status']);

export const COMMAND_READ_TOOLS = new Set([
  'get_device_scripting_options',
  'get_powershell_result',
]);

export const TICKET_WRITE_TOOLS = new Set([
  'create_ticket',
  'update_ticket',
  'add_ticket_comment',
]);

export const DEVICE_SCRIPT_TOOLS = new Set([
  'run_device_script',
  'run_device_powershell',
]);

export const SOFTWARE_DEPLOYMENT_TOOLS = new Set([
  'scan_device_os_patches',
  'apply_device_os_patches',
  'scan_device_software_patches',
  'apply_device_software_patches',
]);

export const REMOTE_CONTROL_TOOLS = new Set<string>([]);

export const DESTRUCTIVE_TOOLS = new Set([
  'delete_end_user',
  'delete_contact',
  'delete_webhook_config',
  'reset_device_policy_overrides',
  'remove_role_members',
]);

export const DEVICE_MANAGEMENT_TOOLS = new Set([
  'reboot_device',
  'set_device_maintenance',
  'update_device',
  'reset_alert',
  'control_windows_service',
  'configure_windows_service',
  'approve_devices',
  'assign_device_policy',
]);

export const DEVICE_TARGET_WRITE_TOOLS = new Set([
  'reboot_device',
  'set_device_maintenance',
  'update_device',
  'control_windows_service',
  'configure_windows_service',
  'scan_device_os_patches',
  'apply_device_os_patches',
  'scan_device_software_patches',
  'apply_device_software_patches',
  'update_device_custom_fields',
  'run_device_script',
  'run_device_powershell',
  'assign_device_policy',
]);

export const ORGANIZATION_TARGET_WRITE_ARGUMENTS: Record<string, string> = {
  generate_organization_installer: 'organizationId',
  update_organization: 'id',
  create_location: 'organizationId',
  update_location: 'organizationId',
  create_end_user: 'organizationId',
  create_contact: 'organizationId',
  update_org_custom_fields: 'orgId',
};

export const OTHER_COMMAND_WRITE_TOOLS = new Set([
  'generate_organization_installer',
  'create_organization',
  'update_organization',
  'create_location',
  'update_location',
  'create_end_user',
  'update_end_user',
  'add_role_members',
  'create_contact',
  'update_contact',
  'update_device_custom_fields',
  'update_org_custom_fields',
  'set_webhook_config',
]);

export const WRITE_TOOLS = new Set([
  ...TICKET_WRITE_TOOLS,
  ...DEVICE_SCRIPT_TOOLS,
  ...SOFTWARE_DEPLOYMENT_TOOLS,
  ...REMOTE_CONTROL_TOOLS,
  ...DESTRUCTIVE_TOOLS,
  ...DEVICE_MANAGEMENT_TOOLS,
  ...OTHER_COMMAND_WRITE_TOOLS,
]);

/**
 * Tools that act on endpoints (or destroy tenant data) and have no plan →
 * trusted-approval path of their own. `confirm: true` is a model-supplied
 * flag, not approval, so on the command profile these are refused outright
 * while plan approval is required (the default). `run_device_powershell` is
 * NOT listed: it already routes through the plan pipeline, and every
 * endpoint action should go through it (runbooks or reviewed custom
 * scripts). `run_device_script` IS listed — it can invoke any saved
 * NinjaOne script, including the PowerShell runner itself, which would be
 * a complete bypass of plan approval.
 */
export const APPROVAL_PIPELINE_ONLY_TOOLS = new Set([
  'run_device_script',
  ...DEVICE_MANAGEMENT_TOOLS,
  ...SOFTWARE_DEPLOYMENT_TOOLS,
  ...REMOTE_CONTROL_TOOLS,
  ...DESTRUCTIVE_TOOLS,
]);

/** True when a direct call must be refused in favor of the approval pipeline. */
export function requiresApprovalPipeline(name: string, security: Pick<RuntimeSecurity, 'profile'>, planApprovalOn: boolean): boolean {
  return security.profile === 'command' && planApprovalOn && APPROVAL_PIPELINE_ONLY_TOOLS.has(name);
}

/**
 * M5A operation-contract tools. These are the approval pipeline itself —
 * not WRITE_TOOLS (no confirm-guard rewrite; approval is the browser path).
 * Command profile only: reporting never exposes endpoint-execution surface.
 */
export const OPERATION_PLAN_TOOLS = new Set([
  'create_plan',
  'dispatch_plan',
  'cancel_operation',
]);

/**
 * REVIEW-1 local collaboration writes. NOT in WRITE_TOOLS — no confirm
 * guard, no endpoint capability; these mutate only local review records.
 * Both profiles may use them when the policy grants reviewWritesEnabled —
 * the explicit app grant required by the review plan.
 */
export const REVIEW_WRITE_TOOLS = new Set([
  'propose_review_item',
  'revise_review_item',
  'ask_review_question',
  'answer_review_question',
  'add_org_annotation',
  'record_review_decision',
  'suppress_review',
  'link_review_operation',
]);

const COMMAND_KNOWN_TOOLS = new Set([
  ...REPORTING_READ_TOOLS,
  ...KNOWLEDGE_READ_TOOLS,
  ...HEALTH_PLAN_TOOLS,
  ...COMMAND_READ_TOOLS,
  ...WRITE_TOOLS,
  ...OPERATION_PLAN_TOOLS,
  ...REVIEW_WRITE_TOOLS,
]);

const INTERNALLY_CONFIRM_GUARDED = new Set([
  'reboot_device',
  'set_device_maintenance',
  'update_device',
  'reset_alert',
  'apply_device_os_patches',
  'apply_device_software_patches',
  'approve_devices',
  'reset_device_policy_overrides',
  'update_device_custom_fields',
  'update_org_custom_fields',
  'create_ticket',
  'update_ticket',
  'add_ticket_comment',
  'set_webhook_config',
  'delete_webhook_config',
  'run_device_script',
  'run_device_powershell',
  'assign_device_policy',
]);

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function parsePolicy(raw: unknown): LocalPolicy {
  if (!raw || typeof raw !== 'object') {
    throw new Error('NinjaOne policy must be a JSON object');
  }
  const value = raw as Record<string, unknown>;
  const allowedOrganizationIds = Array.isArray(value.allowedOrganizationIds)
    ? value.allowedOrganizationIds.filter((id): id is number => Number.isInteger(id) && id > 0)
    : [];
  const defaultOrganizationId =
    typeof value.defaultOrganizationId === 'number' &&
    Number.isInteger(value.defaultOrganizationId) &&
    value.defaultOrganizationId > 0
      ? value.defaultOrganizationId
      : null;
  const blockedActions = Array.isArray(value.blockedActions)
    ? value.blockedActions.filter((name): name is string => typeof name === 'string')
    : [];

  return {
    allowedOrganizationIds,
    defaultOrganizationId,
    blockedActions,
    ticketWritesEnabled: parseBoolean(value.ticketWritesEnabled, false),
    deviceManagementEnabled: parseBoolean(value.deviceManagementEnabled, false),
    administrativeWritesEnabled: parseBoolean(value.administrativeWritesEnabled, false),
    deviceScriptsEnabled: parseBoolean(value.deviceScriptsEnabled, false),
    powershellRunnerScriptId:
      typeof value.powershellRunnerScriptId === 'number' &&
      Number.isInteger(value.powershellRunnerScriptId) &&
      value.powershellRunnerScriptId > 0
        ? value.powershellRunnerScriptId
        : null,
    softwareDeploymentEnabled: parseBoolean(value.softwareDeploymentEnabled, false),
    reviewWritesEnabled: parseBoolean(value.reviewWritesEnabled, false),
    remoteControlEnabled: parseBoolean(value.remoteControlEnabled, false),
    destructiveOperationsEnabled: parseBoolean(value.destructiveOperationsEnabled, false),
    healthWritebackEnabled: parseBoolean(value.healthWritebackEnabled, false),
    powershellSessionTtlSeconds:
      typeof value.powershellSessionTtlSeconds === 'number' && value.powershellSessionTtlSeconds > 0
        ? value.powershellSessionTtlSeconds
        : undefined,
    powershellSessionMaxCommands:
      typeof value.powershellSessionMaxCommands === 'number' &&
      Number.isInteger(value.powershellSessionMaxCommands) &&
      value.powershellSessionMaxCommands >= 0
        ? value.powershellSessionMaxCommands
        : undefined,
  };
}

export function loadRuntimeSecurity(): RuntimeSecurity {
  const configuredProfile = (process.env.NINJA_AUTH_PROFILE || '').trim().toLowerCase();
  if (configuredProfile !== 'reporting' && configuredProfile !== 'command') {
    throw new Error('NINJA_AUTH_PROFILE must be set to reporting or command');
  }

  const principal: Principal = {
    profile: configuredProfile,
    credentialKind: configuredProfile === 'reporting' ? 'client_credentials' : 'native_pkce',
  };

  const policyPath = (process.env.NINJA_POLICY_PATH || '').trim();
  if (!policyPath) {
    return { profile: configuredProfile, principal, policy: SAFE_DEFAULT_POLICY };
  }

  try {
    const policy = parsePolicy(JSON.parse(readFileSync(policyPath, 'utf8')));
    return { profile: configuredProfile, principal, policy };
  } catch (error) {
    throw new Error(
      `Failed to load NinjaOne policy from ${policyPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function isToolAllowed(name: string, security: RuntimeSecurity): boolean {
  if (security.profile === 'reporting') {
    // Local review-record writes are the only non-read surface reporting
    // may reach, and only under the explicit policy grant.
    if (REVIEW_WRITE_TOOLS.has(name)) return security.policy.reviewWritesEnabled;
    return REPORTING_READ_TOOLS.has(name) || KNOWLEDGE_READ_TOOLS.has(name);
  }
  if (!COMMAND_KNOWN_TOOLS.has(name)) return false;
  if (REVIEW_WRITE_TOOLS.has(name) && !security.policy.reviewWritesEnabled) return false;
  if (security.policy.blockedActions.includes(name)) return false;
  if (DESTRUCTIVE_TOOLS.has(name) && !security.policy.destructiveOperationsEnabled) return false;
  if (TICKET_WRITE_TOOLS.has(name) && !security.policy.ticketWritesEnabled) return false;
  if (DEVICE_MANAGEMENT_TOOLS.has(name) && !security.policy.deviceManagementEnabled) return false;
  if (OTHER_COMMAND_WRITE_TOOLS.has(name) && !security.policy.administrativeWritesEnabled) return false;
  if (DEVICE_SCRIPT_TOOLS.has(name) && !security.policy.deviceScriptsEnabled) return false;
  if (SOFTWARE_DEPLOYMENT_TOOLS.has(name) && !security.policy.softwareDeploymentEnabled) return false;
  if (REMOTE_CONTROL_TOOLS.has(name) && !security.policy.remoteControlEnabled) return false;
  if (HEALTH_PLAN_TOOLS.has(name) && !security.policy.healthWritebackEnabled) return false;
  return true;
}

export function toolRequiresGenericConfirmation(name: string): boolean {
  return WRITE_TOOLS.has(name) && !INTERNALLY_CONFIRM_GUARDED.has(name);
}

export function filterTools<T extends ToolDefinition>(
  tools: T[],
  security: RuntimeSecurity,
): T[] {
  return tools
    .filter((tool) => isToolAllowed(tool.name, security))
    .map((tool) => {
      if (!WRITE_TOOLS.has(tool.name) || !tool.inputSchema) return tool;
      return {
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            ...(tool.inputSchema.properties || {}),
            confirm: {
              type: 'boolean',
              description: 'Set to true to execute. Default false (dry-run).',
            },
          },
        },
      };
    });
}
