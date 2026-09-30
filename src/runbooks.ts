/**
 * M5A — versioned, reviewed runbooks.
 *
 * Runbooks are source-controlled and immutable: editing a script means
 * publishing a NEW version (append-only entries, never edit in place).
 * Approved plans keep their original version + digest.
 *
 * Parameter binding (plan §7): params are validated against a typed schema,
 * serialized to JSON, base64-encoded, and injected as a single-quoted
 * PowerShell string literal decoded into `$__p`. The base64 alphabet cannot
 * contain a single quote, so parameter values can never become executable
 * text — they arrive as data.
 *
 * Result contract: runbook scripts emit one final line `RBJSON:<json>` —
 * a bounded structured result. The raw stdout/stderr receipt is stored
 * separately from the parsed interpretation (plan §7 honest-results rule).
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export interface RunbookParam {
  type: 'string' | 'integer' | 'boolean' | 'enum';
  description: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
}

export interface Runbook {
  id: string;
  version: number;
  title: string;
  purpose: string;
  category: 'diagnostic' | 'maintenance' | 'administration';
  /** Immutable PowerShell body. Reads params via the $__p object. */
  script: string;
  params: Record<string, RunbookParam>;
  applicability: {
    os: string[];
    powershell: string;
    roles?: string[];
    runAs: 'system';
  };
  classification: 'read' | 'modify';
  affectedScope: string;
  sideEffects: string;
  disruption: string;
  timeoutSeconds: number;
  outputLimits: { maxRows: number; maxChars: number };
  retry: 'safe' | 'manual-review';
  resultSchema: { parser: 'rbjson'; version: 1 | 2 | 3 };
  preconditions: string;
  postconditions: string;
  recovery: string;
  review: { status: 'reviewed'; reviewedBy: string; reviewedAt: string };
  /** Set to revoke: blocks new plans without rewriting history. */
  revoked?: string;
}

export class RunbookError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function scriptDigest(script: string): string {
  return createHash('sha256').update(script, 'utf8').digest('hex');
}

/* ── Diagnostic runbooks (plan §7 first set: bounded reads, small outputs) ── */

const RB_JSON_FOOTER = `'RBJSON:' + ($__result | ConvertTo-Json -Compress -Depth 6)`;

/*
 * INFRA-1 K0 — versioned collection contract (resultSchema version 2).
 *
 * v2 runbooks report per-SECTION outcomes so ingestion can accept partial
 * evidence honestly: each section carries status
 * (complete | partial | failed | unverified | not-applicable), scope, and —
 * for native tools — the tool's own exit code captured IMMEDIATELY after the
 * call and stored as data ($__native). Native codes are preserved, never
 * propagated as the script's exit and never silently treated as success or
 * failure; section status is derived from output completeness instead.
 *
 * The script's own exit is an explicit aggregate of section outcomes:
 *   complete → 0, partial → 2, failed → 1.
 * This separates transport outcome (did the collector run) from collection
 * outcome (did every measurement succeed) from findings (what was found).
 */
const RB_JSON_FOOTER_V2 = [
  `$__agg = 'complete'; $__measured = 0; $__failedSections = 0`,
  `foreach ($__s in $__sections.Values) {`,
  `  if ($__s.status -ne 'not-applicable') { $__measured++ }`,
  `  if ($__s.status -in @('failed','partial','unverified')) { $__agg = 'partial' }`,
  `  if ($__s.status -eq 'failed') { $__failedSections++ }`,
  `}`,
  `if ($__measured -gt 0 -and $__failedSections -eq $__measured) { $__agg = 'failed' }`,
  `if ($__measured -eq 0) { $__agg = 'failed' }`,
  `$__result.collection = [ordered]@{ schemaVersion = 2; status = $__agg; sections = $__sections; nativeExitCodes = $__native }`,
  `'RBJSON:' + ($__result | ConvertTo-Json -Compress -Depth 8)`,
  `if ($__agg -eq 'complete') { exit 0 } elseif ($__agg -eq 'partial') { exit 2 } else { exit 1 }`,
].join('\n');

/*
 * INFRA-1 K4 — transport-budgeted emission (resultSchema version 3).
 *
 * NinjaOne caps activity output at ~10K chars; a large RBJSON line pushes
 * the runner's trailing RESULT markers past the cap and the receipt is
 * destroyed upstream (observed on diag/gpo-inventory v2 — 31 GPOs with link
 * detail produced ~14K of JSON). v3 emits plain RBJSON while it fits;
 * larger results are gzip+base64'd and emitted as RBJGZ:<b64> — the
 * identical payload, recoverable intact. If even the compressed wire
 * exceeds the bound, entity detail is dropped and every complete section
 * degrades to 'partial' (dropped evidence may never read as a complete
 * enumeration — absence must not be inferred from a transport cut).
 */
const RB_JSON_FOOTER_V3 = [
  `$__agg = 'complete'; $__measured = 0; $__failedSections = 0`,
  `foreach ($__s in $__sections.Values) {`,
  `  if ($__s.status -ne 'not-applicable') { $__measured++ }`,
  `  if ($__s.status -in @('failed','partial','unverified')) { $__agg = 'partial' }`,
  `  if ($__s.status -eq 'failed') { $__failedSections++ }`,
  `}`,
  `if ($__measured -gt 0 -and $__failedSections -eq $__measured) { $__agg = 'failed' }`,
  `if ($__measured -eq 0) { $__agg = 'failed' }`,
  `$__result.collection = [ordered]@{ schemaVersion = 3; status = $__agg; sections = $__sections; nativeExitCodes = $__native }`,
  `$__json = $__result | ConvertTo-Json -Compress -Depth 8`,
  `if ($__json.Length -le 7000) {`,
  `  'RBJSON:' + $__json`,
  `} else {`,
  `  $__pack = { param($__o) $__j = $__o | ConvertTo-Json -Compress -Depth 8; $__b = [Text.Encoding]::UTF8.GetBytes($__j); $__m = New-Object IO.MemoryStream; $__g = New-Object IO.Compression.GzipStream($__m, [IO.Compression.CompressionMode]::Compress); $__g.Write($__b, 0, $__b.Length); $__g.Dispose(); $__w = 'RBJGZ:' + [Convert]::ToBase64String($__m.ToArray()); $__m.Dispose(); return $__w }`,
  `  $__wire = & $__pack $__result`,
  `  if ($__wire.Length -gt 8200) {`,
  `    foreach ($__s in $__sections.Values) { if ($__s.status -eq 'complete') { $__s.status = 'partial'; $__s.note = 'collected but payload exceeded transport budget - entity detail dropped' } }`,
  `    $__agg = 'partial'`,
  `    $__result.collection.status = 'partial'`,
  `    $__min = [ordered]@{ payloadDropped = $true; reason = 'compressed result exceeded transport budget'; collection = $__result.collection; errors = $__result.errors }`,
  `    $__wire = & $__pack $__min`,
  `  }`,
  `  $__wire`,
  `}`,
  `if ($__agg -eq 'complete') { exit 0 } elseif ($__agg -eq 'partial') { exit 2 } else { exit 1 }`,
].join('\n');

export const RUNBOOKS: Runbook[] = [
  {
    id: 'diag/service-state',
    version: 1,
    title: 'Service state and recent service failures',
    purpose: 'List services (optionally filtered) plus recent Service Control Manager error events.',
    category: 'diagnostic',
    script: [
      `$maxRows = [int]$__p.maxRows`,
      `$pattern = [string]$__p.namePattern`,
      `$state = [string]$__p.state`,
      `$__result = [ordered]@{ services = @(); recentServiceErrors = @(); errors = @() }`,
      `try {`,
      `  $svcs = Get-CimInstance Win32_Service | Select-Object Name, DisplayName, State, StartMode, StartName, ProcessId`,
      `  if ($pattern) { $svcs = $svcs | Where-Object { $_.Name -like "*$pattern*" -or $_.DisplayName -like "*$pattern*" } }`,
      `  if ($state -eq 'running') { $svcs = $svcs | Where-Object State -eq 'Running' }`,
      `  elseif ($state -eq 'stopped') { $svcs = $svcs | Where-Object State -eq 'Stopped' }`,
      `  elseif ($state -eq 'auto-not-running') { $svcs = $svcs | Where-Object { $_.StartMode -eq 'Auto' -and $_.State -ne 'Running' } }`,
      `  $__result.services = @($svcs | Select-Object -First $maxRows)`,
      `  $__result.totalMatched = @($svcs).Count`,
      `} catch { $__result.errors += "services: $($_.Exception.Message)" }`,
      `try {`,
      `  $__result.recentServiceErrors = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; Level = 2,3; StartTime = (Get-Date).AddHours(-24) } -MaxEvents 25 -ErrorAction Stop |`,
      `    Select-Object TimeCreated, Id, LevelDisplayName, @{n='Message';e={ $_.Message.Substring(0, [Math]::Min(300, $_.Message.Length)) }})`,
      `} catch { }`,
      RB_JSON_FOOTER,
    ].join('\n'),
    params: {
      namePattern: { type: 'string', description: 'Wildcard match on service name/display name', required: false, maxLength: 100 },
      state: { type: 'enum', description: 'Subset to return', enum: ['all', 'running', 'stopped', 'auto-not-running'], default: 'all' },
      maxRows: { type: 'integer', description: 'Max services returned (1-500)', min: 1, max: 500, default: 100 },
    },
    applicability: { os: ['windows'], powershell: '5.1+', runAs: 'system' },
    classification: 'read',
    affectedScope: 'target endpoint only',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 120,
    outputLimits: { maxRows: 500, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 1 },
    preconditions: 'none',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-22' },
  },
  {
    id: 'diag/event-log-tail',
    version: 1,
    title: 'Filtered recent event-log records',
    purpose: 'Pull bounded recent events from an approved log with optional level filter.',
    category: 'diagnostic',
    script: [
      `$logName = [string]$__p.logName`,
      `$sinceMin = [int]$__p.sinceMinutes`,
      `$maxRows = [int]$__p.maxRows`,
      `$__result = [ordered]@{ logName = $logName; sinceMinutes = $sinceMin; events = @(); errors = @() }`,
      `try {`,
      `  $filter = @{ LogName = $logName; StartTime = (Get-Date).AddMinutes(-$sinceMin) }`,
      `  if ($__p.level -and $__p.level -ne 'all') {`,
      `    $filter.Level = switch ($__p.level) { 'critical' {1} 'error' {2} 'warning' {3} 'information' {4} }`,
      `  }`,
      `  $__result.events = @(Get-WinEvent -FilterHashtable $filter -MaxEvents $maxRows -ErrorAction Stop |`,
      `    Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, @{n='Message';e={ if ($_.Message) { $_.Message.Substring(0, [Math]::Min(400, $_.Message.Length)) } else { '' } }})`,
      `  $__result.returned = @($__result.events).Count`,
      `} catch { $__result.errors += $_.Exception.Message }`,
      RB_JSON_FOOTER,
    ].join('\n'),
    params: {
      logName: {
        type: 'enum',
        description: 'Approved log to read',
        enum: ['Application', 'System', 'Security', 'Windows PowerShell', 'Microsoft-Windows-WindowsUpdateClient/Operational', 'Microsoft-Windows-PrintService/Operational', 'Microsoft-Windows-GroupPolicy/Operational'],
        required: true,
      },
      level: { type: 'enum', description: 'Severity filter', enum: ['all', 'critical', 'error', 'warning', 'information'], default: 'all' },
      sinceMinutes: { type: 'integer', description: 'Look-back window (1-10080 min)', min: 1, max: 10080, default: 60 },
      maxRows: { type: 'integer', description: 'Max events (1-200)', min: 1, max: 200, default: 50 },
    },
    applicability: { os: ['windows'], powershell: '5.1+', runAs: 'system' },
    classification: 'read',
    affectedScope: 'target endpoint only',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 120,
    outputLimits: { maxRows: 200, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 1 },
    preconditions: 'none',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-22' },
  },
  {
    id: 'diag/windows-update-triage',
    version: 1,
    title: 'Windows Update failure triage',
    purpose: 'WU-related service states, pending-reboot flags, and recent WindowsUpdateClient events.',
    category: 'diagnostic',
    script: [
      `$sinceH = [int]$__p.sinceHours`,
      `$maxRows = [int]$__p.maxRows`,
      `$__result = [ordered]@{ services = @(); pendingReboot = [ordered]@{}; recentEvents = @(); errors = @() }`,
      `try {`,
      `  $__result.services = @(Get-CimInstance Win32_Service -Filter "Name='wuauserv' OR Name='bits' OR Name='dosvc' OR Name='UsoSvc' OR Name='cryptsvc'" |`,
      `    Select-Object Name, DisplayName, State, StartMode)`,
      `} catch { $__result.errors += "services: $($_.Exception.Message)" }`,
      `try {`,
      `  $__result.pendingReboot = [ordered]@{`,
      `    componentBasedServicing = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending')`,
      `    windowsUpdateAutoUpdate = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')`,
      `    fileRenameOperations = [bool](Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue)`,
      `  }`,
      `} catch { $__result.errors += "reboot-flags: $($_.Exception.Message)" }`,
      `try {`,
      `  $__result.recentEvents = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-WindowsUpdateClient/Operational'; StartTime = (Get-Date).AddHours(-$sinceH) } -MaxEvents $maxRows -ErrorAction Stop |`,
      `    Select-Object TimeCreated, Id, LevelDisplayName, @{n='Message';e={ if ($_.Message) { $_.Message.Substring(0, [Math]::Min(400, $_.Message.Length)) } else { '' } }})`,
      `} catch { $__result.errors += "events: $($_.Exception.Message)" }`,
      RB_JSON_FOOTER,
    ].join('\n'),
    params: {
      sinceHours: { type: 'integer', description: 'Event look-back window (1-720 h)', min: 1, max: 720, default: 168 },
      maxRows: { type: 'integer', description: 'Max events (1-100)', min: 1, max: 100, default: 30 },
    },
    applicability: { os: ['windows'], powershell: '5.1+', runAs: 'system' },
    classification: 'read',
    affectedScope: 'target endpoint only',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 120,
    outputLimits: { maxRows: 100, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 1 },
    preconditions: 'none',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-22' },
  },
  {
    id: 'diag/network-dns-config',
    version: 1,
    title: 'NIC and DNS configuration',
    purpose: 'Interfaces, IP addresses, configured DNS servers, and DHCP flags.',
    category: 'diagnostic',
    script: [
      `$alias = [string]$__p.interfaceAlias`,
      `$__result = [ordered]@{ interfaces = @(); errors = @() }`,
      `try {`,
      `  $adapters = Get-NetIPConfiguration -ErrorAction Stop`,
      `  if ($alias) { $adapters = $adapters | Where-Object { $_.InterfaceAlias -like "*$alias*" } }`,
      `  $__result.interfaces = @($adapters | ForEach-Object {`,
      `    $dns = @(($_ | Select-Object -ExpandProperty DNSServer -ErrorAction SilentlyContinue) | Where-Object { $_.AddressFamily -eq 2 } | Select-Object -ExpandProperty ServerAddresses -ErrorAction SilentlyContinue)`,
      `    [ordered]@{`,
      `      alias = $_.InterfaceAlias; description = $_.InterfaceDescription; status = [string]$_.NetAdapter.Status`,
      `      ipv4 = @($_.IPv4Address.IPAddress); gateway = @($_.IPv4DefaultGateway.NextHop)`,
      `      dnsServers = @($dns); dhcpEnabled = [bool]($_.NetIPv4Interface.Dhcp -eq 'Enabled')`,
      `    }`,
      `  })`,
      `} catch { $__result.errors += $_.Exception.Message }`,
      RB_JSON_FOOTER,
    ].join('\n'),
    params: {
      interfaceAlias: { type: 'string', description: 'Wildcard match on interface alias', required: false, maxLength: 100 },
    },
    applicability: { os: ['windows'], powershell: '5.1+', runAs: 'system' },
    classification: 'read',
    affectedScope: 'target endpoint only',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 120,
    outputLimits: { maxRows: 100, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 1 },
    preconditions: 'none',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-22' },
  },
  {
    id: 'diag/print-spooler',
    version: 1,
    title: 'Print spooler state and queue summary',
    purpose: 'Spooler service state, printer/job counts, recent PrintService errors. Never restarts or deletes.',
    category: 'diagnostic',
    script: [
      `$maxRows = [int]$__p.maxRows`,
      `$__result = [ordered]@{ spooler = $null; printers = @(); queuedJobs = 0; recentErrors = @(); errors = @() }`,
      `try {`,
      `  $__result.spooler = @(Get-CimInstance Win32_Service -Filter "Name='spooler'" | Select-Object Name, State, StartMode, ProcessId)[0]`,
      `} catch { $__result.errors += "spooler: $($_.Exception.Message)" }`,
      `try {`,
      `  $__result.printers = @(Get-Printer -ErrorAction Stop | Select-Object -First $maxRows Name, DriverName, PortName, PrinterStatus)`,
      `  $__result.queuedJobs = @($__result.printers | ForEach-Object { Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue }).Count`,
      `} catch { $__result.errors += "printers: $($_.Exception.Message)" }`,
      `try {`,
      `  $__result.recentErrors = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-PrintService/Operational'; Level = 2,3; StartTime = (Get-Date).AddHours(-24) } -MaxEvents 25 -ErrorAction Stop |`,
      `    Select-Object TimeCreated, Id, LevelDisplayName, @{n='Message';e={ if ($_.Message) { $_.Message.Substring(0, [Math]::Min(300, $_.Message.Length)) } else { '' } }})`,
      `} catch { }`,
      RB_JSON_FOOTER,
    ].join('\n'),
    params: {
      maxRows: { type: 'integer', description: 'Max printers returned (1-100)', min: 1, max: 100, default: 50 },
    },
    applicability: { os: ['windows'], powershell: '5.1+', runAs: 'system' },
    classification: 'read',
    affectedScope: 'target endpoint only',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 120,
    outputLimits: { maxRows: 100, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 1 },
    preconditions: 'none',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-22' },
  },

/* ── M5C: role-scoped diagnostics + maintenance runbooks ─────────────────── */

  {
    id: 'diag/dns-server',
    version: 1,
    title: 'DNS server zones and forwarders',
    purpose: 'On a DNS server (usually a DC): zones, DS-integration, forwarders, scavenging state. Reports rolePresent:false cleanly on non-DNS hosts.',
    category: 'diagnostic',
    script: [
      `$__result = [ordered]@{ rolePresent = $false; moduleAvailable = $false; zones = @(); forwarders = @(); scavenging = $null; errors = @() }`,
      `$__result.rolePresent = [bool](Get-Service -Name DNS -ErrorAction SilentlyContinue)`,
      `if ($__result.rolePresent) {`,
      `  $__result.moduleAvailable = [bool](Get-Module -ListAvailable -Name DnsServer)`,
      `  if ($__result.moduleAvailable) {`,
      `    try { $__result.zones = @(Get-DnsServerZone -ErrorAction Stop | Select-Object ZoneName, ZoneType, IsDsIntegrated, IsReverseLookupZone, DynamicUpdate) } catch { $__result.errors += "zones: $($_.Exception.Message)" }`,
      `    try { $__result.forwarders = @((Get-DnsServerForwarder -ErrorAction Stop).IPAddress.IPAddressToString) } catch { $__result.errors += "forwarders: $($_.Exception.Message)" }`,
      `    try {`,
      `      $scav = Get-DnsServerScavenging -ErrorAction Stop`,
      `      $__result.scavenging = [ordered]@{ enabled = [bool]$scav.ScavengingState; intervalHours = [string]$scav.ScavengingInterval }`,
      `    } catch { }`,
      `  } else { $__result.errors += 'DNS service present but DnsServer module unavailable — install RSAT DNS tools' }`,
      `} else { $__result.errors += 'DNS Server service not installed on this endpoint — role not applicable' }`,
      RB_JSON_FOOTER,
    ].join('\n'),
    params: {},
    applicability: { os: ['windows-server'], powershell: '5.1+', roles: ['dns-server'], runAs: 'system' },
    classification: 'read',
    affectedScope: 'domain-wide name resolution config (read only)',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 120,
    outputLimits: { maxRows: 200, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 1 },
    preconditions: 'DNS Server role on the target (detected, not assumed)',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-23' },
  },
  {
    id: 'diag/dhcp-scopes',
    version: 1,
    title: 'DHCP scopes, utilization, and failover',
    purpose: 'On a DHCP server: v4 scopes with free/used counts, failover state. Reports rolePresent:false cleanly on non-DHCP hosts.',
    category: 'diagnostic',
    script: [
      `$__result = [ordered]@{ rolePresent = $false; moduleAvailable = $false; scopes = @(); failover = @(); errors = @() }`,
      `$__result.rolePresent = [bool](Get-Service -Name DHCPServer -ErrorAction SilentlyContinue)`,
      `if ($__result.rolePresent) {`,
      `  $__result.moduleAvailable = [bool](Get-Module -ListAvailable -Name DhcpServer)`,
      `  if ($__result.moduleAvailable) {`,
      `    try {`,
      `      $__result.scopes = @(Get-DhcpServerv4Scope -ErrorAction Stop | ForEach-Object {`,
      `        $stats = Get-DhcpServerv4ScopeStatistics -ScopeId $_.ScopeId -ErrorAction SilentlyContinue`,
      `        [ordered]@{ scopeId = [string]$_.ScopeId; name = $_.Name; state = [string]$_.State; start = [string]$_.StartRange; end = [string]$_.EndRange; inUse = $stats.AddressesInUse; free = $stats.AddressesFree; pctUsed = if ($stats.PercentageInUse) { [math]::Round($stats.PercentageInUse,1) } else { $null } }`,
      `      })`,
      `    } catch { $__result.errors += "scopes: $($_.Exception.Message)" }`,
      `    try { $__result.failover = @(Get-DhcpServerv4Failover -ErrorAction SilentlyContinue | Select-Object Name, Mode, State, PartnerServer) } catch { }`,
      `  } else { $__result.errors += 'DHCP service present but DhcpServer module unavailable — install RSAT DHCP tools' }`,
      `} else { $__result.errors += 'DHCP Server service not installed on this endpoint — role not applicable' }`,
      RB_JSON_FOOTER,
    ].join('\n'),
    params: {},
    applicability: { os: ['windows-server'], powershell: '5.1+', roles: ['dhcp-server'], runAs: 'system' },
    classification: 'read',
    affectedScope: 'site/subnet address allocation config (read only)',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 120,
    outputLimits: { maxRows: 200, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 1 },
    preconditions: 'DHCP Server role on the target (detected, not assumed)',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-23' },
  },
  {
    id: 'diag/ad-health',
    version: 1,
    title: 'AD DS health: FSMO, replication, sites',
    purpose: 'On a domain controller: FSMO roles, replication errors (repadmin /showrepl /errorsonly), site/subnet counts. rolePresent:false on non-DCs.',
    category: 'diagnostic',
    script: [
      `$__result = [ordered]@{ rolePresent = $false; fsmo = $null; replicationErrors = @(); sites = $null; dcCount = $null; errors = @() }`,
      `$__result.rolePresent = [bool](Get-Service -Name NTDS -ErrorAction SilentlyContinue)`,
      `if ($__result.rolePresent) {`,
      `  if (Get-Module -ListAvailable -Name ActiveDirectory) {`,
      `    try {`,
      `      $dom = Get-ADDomain -ErrorAction Stop; $for = Get-ADForest -ErrorAction Stop`,
      `      $__result.fsmo = [ordered]@{ pdc = [string]$dom.PDCEmulator; rid = [string]$dom.RIDMaster; infra = [string]$dom.InfrastructureMaster; schema = [string]$for.SchemaMaster; naming = [string]$for.DomainNamingMaster }`,
      `      $__result.sites = @($for.Sites).Count`,
      `      $__result.dcCount = @($for.GlobalCatalogs).Count`,
      `    } catch { $__result.errors += "ad-module: $($_.Exception.Message)" }`,
      `  } else { $__result.errors += 'NTDS present but ActiveDirectory module unavailable' }`,
      `  try {`,
      `    $repl = repadmin /showrepl /errorsonly 2>&1`,
      `    $__result.replicationErrors = @($repl | Where-Object { $_ -match 'error|fail' } | Select-Object -First 20 | ForEach-Object { [string]$_ })`,
      `  } catch { $__result.errors += "repadmin: $($_.Exception.Message)" }`,
      `} else { $__result.errors += 'NTDS (AD DS) service not installed — this endpoint is not a domain controller' }`,
      RB_JSON_FOOTER,
    ].join('\n'),
    params: {},
    applicability: { os: ['windows-server'], powershell: '5.1+', roles: ['domain-controller'], runAs: 'system' },
    classification: 'read',
    affectedScope: 'entire directory (replication/roles — read only)',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 180,
    outputLimits: { maxRows: 100, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 1 },
    preconditions: 'AD DS role on the target (detected via NTDS service, not assumed)',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-23' },
  },
  {
    id: 'diag/gpo-inventory',
    version: 1,
    title: 'Group Policy inventory and link status',
    purpose: 'Domain GPOs with status/enabled flags. Requires the GroupPolicy module (DC or RSAT host). rolePresent:false on non-domain hosts.',
    category: 'diagnostic',
    script: [
      `$__result = [ordered]@{ domainJoined = $false; moduleAvailable = $false; gpos = @(); total = 0; errors = @() }`,
      `$__result.domainJoined = [bool]((Get-CimInstance Win32_ComputerSystem).PartOfDomain)`,
      `if ($__result.domainJoined) {`,
      `  $__result.moduleAvailable = [bool](Get-Module -ListAvailable -Name GroupPolicy)`,
      `  if ($__result.moduleAvailable) {`,
      `    try {`,
      `      $all = @(Get-GPO -All -ErrorAction Stop | Select-Object DisplayName, Id, GpoStatus, CreationTime, ModificationTime)`,
      `      $__result.total = $all.Count`,
      `      $__result.gpos = @($all | Select-Object -First 200)`,
      `    } catch { $__result.errors += "gpo: $($_.Exception.Message)" }`,
      `  } else { $__result.errors += 'GroupPolicy module unavailable — run on a DC or install RSAT GPMC tools' }`,
      `} else { $__result.errors += 'endpoint is not domain-joined — GPO inventory not applicable' }`,
      RB_JSON_FOOTER,
    ].join('\n'),
    params: {},
    applicability: { os: ['windows'], powershell: '5.1+', roles: ['domain-controller', 'rsat-host'], runAs: 'system' },
    classification: 'read',
    affectedScope: 'domain-wide policy set (read only)',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 120,
    outputLimits: { maxRows: 200, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 1 },
    preconditions: 'domain-joined host with GroupPolicy module (detected, not assumed)',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-23' },
  },
  {
    id: 'maint/uninstall-software',
    version: 1,
    title: 'Silent software uninstall (exact name)',
    purpose: 'Uninstall a program by exact DisplayName across all uninstall hives. MSI → msiexec /x /qn /norestart; EXE uses QuietUninstallString; without a quiet path it stops with status blocked unless allowUnverifiedSilent is set. Re-verifies removal after running.',
    category: 'maintenance',
    script: [
      `$target = [string]$__p.displayName`,
      `$__result = [ordered]@{ displayName = $target; matched = @(); verified = $null; errors = @() }`,
      `$roots = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',`,
      `         'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',`,
      `         'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'`,
      `try {`,
      `  $apps = @(Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $target })`,
      `  if ($apps.Count -eq 0) { $__result.verified = 'not-found'; $__result.errors += "no uninstall entry for exact name: $target" }`,
      `  $exit = 0`,
      `  foreach ($a in $apps) {`,
      `    $entry = [ordered]@{ name = $a.DisplayName; version = [string]$a.DisplayVersion; hive = [string]$a.PSPath; kind = $null; status = 'pending' }`,
      `    $u = $a.QuietUninstallString; $quiet = $true`,
      `    if (-not $u) { $u = $a.UninstallString; $quiet = $false }`,
      `    if (-not $u) { $entry.status = 'unsupported'; $entry.reason = 'no uninstall string at all'; $__result.matched += $entry; continue }`,
      `    if ($a.PSChildName -like '{*' -or $u -match '(?i)msiexec') {`,
      `      $entry.kind = 'msi'`,
      `      $p = Start-Process msiexec.exe -ArgumentList '/x', "$($a.PSChildName)", '/qn', '/norestart' -Wait -PassThru`,
      `    } else {`,
      `      $entry.kind = if ($quiet) { 'exe-quiet' } else { 'exe-vendor' }`,
      `      if (-not $quiet -and -not [bool]$__p.allowUnverifiedSilent) {`,
      `        $entry.status = 'blocked'`,
      `        $entry.reason = 'only vendor UninstallString (no quiet variant) — set allowUnverifiedSilent=true to accept interactive-risk uninstaller'`,
      `        $__result.matched += $entry; continue`,
      `      }`,
      `      $p = Start-Process cmd.exe -ArgumentList '/c', "$u" -Wait -PassThru`,
      `    }`,
      `    $entry.exitCode = $p.ExitCode`,
      `    $entry.status = if ($p.ExitCode -eq 0) { 'uninstall-ran' } else { "exit-$($p.ExitCode)" }`,
      `    if ($p.ExitCode -ne 0) { $exit = $p.ExitCode }`,
      `    $__result.matched += $entry`,
      `  }`,
      `  $still = @(Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $target })`,
      `  if (-not $__result.verified) { $__result.verified = if ($still.Count -eq 0) { 'removed' } elseif (@($__result.matched | Where-Object { $_.status -eq 'blocked' }).Count -eq @($__result.matched).Count -and $__result.matched.Count -gt 0) { 'blocked' } else { 'still-present' } }`,
      `  if ($__result.verified -eq 'still-present') { exit 1 }`,
      `  exit $exit`,
      `} catch { $__result.errors += $_.Exception.Message; 'RBJSON:' + ($__result | ConvertTo-Json -Compress -Depth 6); exit 9 }`,
      RB_JSON_FOOTER,
    ].join('\n'),
    params: {
      displayName: { type: 'string', description: 'Exact registry DisplayName (case-sensitive, e.g. "7-Zip 24.05 (x64)")', required: true, maxLength: 200 },
      allowUnverifiedSilent: { type: 'boolean', description: 'Accept vendor UninstallString without a quiet flag (may prompt or fail non-silently)', default: false },
    },
    applicability: { os: ['windows'], powershell: '5.1+', runAs: 'system' },
    classification: 'modify',
    affectedScope: 'installed software on the target endpoint',
    sideEffects: 'removes the named software; vendor uninstaller side effects (driver removal, reboot prompts suppressed via /norestart where MSI)',
    disruption: 'low — user-visible program removal; running app may force-close',
    timeoutSeconds: 600,
    outputLimits: { maxRows: 50, maxChars: 8000 },
    retry: 'manual-review',
    resultSchema: { parser: 'rbjson', version: 1 },
    preconditions: 'software installed for machine or current user hive',
    postconditions: 'verified: removed | still-present | blocked | not-found in result',
    recovery: 'reinstall from original source; no rollback snapshot is taken',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-23' },
  },
  {
    id: 'maint/install-msi',
    version: 1,
    title: 'Silent MSI install from URL or share',
    purpose: 'Download an MSI (https or UNC), optional SHA256 pin-verify, msiexec /i /qn /norestart, then verify the product registered. Hash mismatch or unreachable source stops before any install.',
    category: 'maintenance',
    script: [
      `$url = [string]$__p.url`,
      `$__result = [ordered]@{ url = $url; downloaded = $false; hashVerified = $null; installed = $null; verified = $null; errors = @() }`,
      `$dst = Join-Path $env:TEMP ("pkg-" + [guid]::NewGuid().Guid + ".msi")`,
      `try {`,
      `  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`,
      `  Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing -TimeoutSec 120 -ErrorAction Stop`,
      `  $__result.downloaded = $true`,
      `  if ($__p.expectedSha256) {`,
      `    $h = (Get-FileHash -Path $dst -Algorithm SHA256).Hash.ToLower()`,
      `    $__result.hashVerified = ($h -eq ([string]$__p.expectedSha256).ToLower())`,
      `    if (-not $__result.hashVerified) { $__result.errors += 'sha256 mismatch — refusing to install'; Remove-Item $dst -Force -ErrorAction SilentlyContinue; 'RBJSON:' + ($__result | ConvertTo-Json -Compress -Depth 6); exit 4 }`,
      `  }`,
      `  $p = Start-Process msiexec.exe -ArgumentList '/i', "\`"$dst\`"", '/qn', '/norestart' -Wait -PassThru`,
      `  $__result.installed = $p.ExitCode`,
      `  Remove-Item $dst -Force -ErrorAction SilentlyContinue`,
      `  if ($p.ExitCode -ne 0) { $__result.errors += "msiexec exit $($p.ExitCode)"; 'RBJSON:' + ($__result | ConvertTo-Json -Compress -Depth 6); exit $p.ExitCode }`,
      `  if ($__p.productNameMatch) {`,
      `    $roots = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'`,
      `    $found = @(Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*$([string]$__p.productNameMatch)*" })`,
      `    $__result.verified = if ($found.Count -gt 0) { 'installed' } else { 'not-found-after-install' }`,
      `    if ($found.Count -eq 0) { 'RBJSON:' + ($__result | ConvertTo-Json -Compress -Depth 6); exit 1 }`,
      `  } else { $__result.verified = 'msiexec-exit-0' }`,
      `  'RBJSON:' + ($__result | ConvertTo-Json -Compress -Depth 6)`,
      `  exit 0`,
      `} catch { $__result.errors += $_.Exception.Message; Remove-Item $dst -Force -ErrorAction SilentlyContinue; 'RBJSON:' + ($__result | ConvertTo-Json -Compress -Depth 6); exit 9 }`,
    ].join('\n'),
    params: {
      url: { type: 'string', description: 'https:// URL or \\\\UNC path to the .msi', required: true, maxLength: 500, pattern: '(https://[^\\s]+\\.msi(\\?[^\\s]*)?|\\\\\\\\[^\\s]+\\.msi)' },
      expectedSha256: { type: 'string', description: 'SHA256 pin — mismatch refuses install before msiexec runs', required: false, maxLength: 64, pattern: '[0-9a-fA-F]{64}' },
      productNameMatch: { type: 'string', description: 'Post-install verify: substring match on registry DisplayName', required: false, maxLength: 200 },
    },
    applicability: { os: ['windows'], powershell: '5.1+', runAs: 'system' },
    classification: 'modify',
    affectedScope: 'installed software on the target endpoint',
    sideEffects: 'installs the package; msiexec may write Program Files + registry; /norestart suppresses reboot but the product may still need one',
    disruption: 'low — silent install; brief CPU/disk during download+install',
    timeoutSeconds: 900,
    outputLimits: { maxRows: 50, maxChars: 8000 },
    retry: 'manual-review',
    resultSchema: { parser: 'rbjson', version: 1 },
    preconditions: 'reachable package URL/UNC; msiexec present; hash pin recommended for internet sources',
    postconditions: 'verified: installed | not-found-after-install | msiexec-exit-0 (no name check) in result',
    recovery: 'uninstall via maint/uninstall-software by product name',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-23' },
  },

  /* ── INFRA-1 K0: v2 sectioned collection contract ─────────────────────
   * Same reads as v1, plus per-section status/completeness/nativeExitCode,
   * an explicit aggregate-derived process exit, and (where it fills a known
   * gap) bounded extra detail: DC inventory, DHCP options, GPO links.
   */
  {
    id: 'diag/ad-health',
    version: 2,
    title: 'AD DS health: FSMO, replication, sites, DC inventory',
    purpose: 'On a domain controller: FSMO roles, domain/forest identity, DC inventory, replication errors via repadmin (native exit preserved as data), site/DC counts. rolePresent:false on non-DCs.',
    category: 'diagnostic',
    script: [
      `$__result = [ordered]@{ rolePresent = $false; fsmo = $null; domain = $null; forest = $null; domainControllers = @(); replicationErrors = @(); sites = $null; dcCount = $null; errors = @() }`,
      `$__sections = [ordered]@{}; $__native = [ordered]@{}`,
      `$__result.rolePresent = [bool](Get-Service -Name NTDS -ErrorAction SilentlyContinue)`,
      `if (-not $__result.rolePresent) {`,
      `  $__sections.roleDetect = [ordered]@{ status = 'complete'; detail = 'NTDS service absent — not a domain controller' }`,
      `  foreach ($n in 'directory','dcInventory','replication') { $__sections[$n] = [ordered]@{ status = 'not-applicable'; detail = 'AD DS role absent' } }`,
      `} else {`,
      `  $__sections.roleDetect = [ordered]@{ status = 'complete'; detail = 'NTDS service present' }`,
      `  if (Get-Module -ListAvailable -Name ActiveDirectory) {`,
      `    try {`,
      `      $dom = Get-ADDomain -ErrorAction Stop; $for = Get-ADForest -ErrorAction Stop`,
      `      $__result.fsmo = [ordered]@{ pdc = [string]$dom.PDCEmulator; rid = [string]$dom.RIDMaster; infra = [string]$dom.InfrastructureMaster; schema = [string]$for.SchemaMaster; naming = [string]$for.DomainNamingMaster }`,
      `      $__result.domain = [ordered]@{ dnsRoot = [string]$dom.DNSRoot; netbios = [string]$dom.NetBIOSName; domainMode = [string]$dom.DomainMode; domainSid = [string]$dom.DomainSID; distinguishedName = [string]$dom.DistinguishedName }`,
      `      $__result.forest = [ordered]@{ name = [string]$for.Name; forestMode = [string]$for.ForestMode; rootDomain = [string]$for.RootDomain }`,
      `      $__result.sites = @($for.Sites).Count`,
      `      $__result.dcCount = @($for.GlobalCatalogs).Count`,
      `      $__sections.directory = [ordered]@{ status = 'complete'; scope = 'domain+forest' }`,
      `    } catch { $__sections.directory = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__result.errors += "directory: $($_.Exception.Message)" }`,
      `    try {`,
      `      $__result.domainControllers = @(Get-ADDomainController -Filter * -ErrorAction Stop | Select-Object -First 50 | ForEach-Object { [ordered]@{ name = [string]$_.Name; host = [string]$_.HostName; site = [string]$_.Site; ip = [string]$_.IPv4Address; os = [string]$_.OperatingSystem; gc = [bool]$_.IsGlobalCatalog; rodc = [bool]$_.IsReadOnly } })`,
      `      $__sections.dcInventory = [ordered]@{ status = 'complete'; count = $__result.domainControllers.Count }`,
      `    } catch { $__sections.dcInventory = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__result.errors += "dcInventory: $($_.Exception.Message)" }`,
      `  } else {`,
      `    $__sections.directory = [ordered]@{ status = 'failed'; error = 'AD module unavailable' }`,
      `    $__sections.dcInventory = [ordered]@{ status = 'failed'; error = 'AD module unavailable' }`,
      `    $__result.errors += 'NTDS present but AD module unavailable'`,
      `  }`,
      `  try {`,
      `    $repl = @(repadmin /showrepl /errorsonly 2>&1)`,
      `    $__native.repadminShowrepl = $LASTEXITCODE; $global:LASTEXITCODE = $null`,
      `    $errLines = @($repl | Where-Object { "$_" -match 'error|fail' } | Select-Object -First 20)`,
      `    $__result.replicationErrors = $errLines`,
      `    $__sections.replication = [ordered]@{ status = $(if ($repl.Count -gt 0 -or $__native.repadminShowrepl -eq 0) { 'complete' } else { 'unverified' }); nativeExitCode = $__native.repadminShowrepl; scope = 'queried DC only' }`,
      `  } catch { $__sections.replication = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__result.errors += "repadmin: $($_.Exception.Message)" }`,
      `}`,
      RB_JSON_FOOTER_V2,
    ].join('\n'),
    params: {},
    applicability: { os: ['windows-server'], powershell: '5.1+', roles: ['domain-controller'], runAs: 'system' },
    classification: 'read',
    affectedScope: 'entire directory (replication/roles — read only)',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 180,
    outputLimits: { maxRows: 100, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 2 },
    preconditions: 'AD DS role on the target (detected via NTDS service, not assumed)',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-24' },
  },
  {
    id: 'diag/dns-server',
    version: 2,
    title: 'DNS server zones, forwarders, scavenging (sectioned)',
    purpose: 'On a DNS server (usually a DC): zones, DS-integration, forwarders, scavenging — each a separately validated section. Reports rolePresent:false cleanly on non-DNS hosts.',
    category: 'diagnostic',
    script: [
      `$__result = [ordered]@{ rolePresent = $false; moduleAvailable = $false; zones = @(); forwarders = @(); scavenging = $null; errors = @() }`,
      `$__sections = [ordered]@{}; $__native = [ordered]@{}`,
      `$__result.rolePresent = [bool](Get-Service -Name DNS -ErrorAction SilentlyContinue)`,
      `if (-not $__result.rolePresent) {`,
      `  $__sections.roleDetect = [ordered]@{ status = 'complete'; detail = 'DNS Server service absent — role not applicable' }`,
      `  foreach ($n in 'zones','forwarders','scavenging') { $__sections[$n] = [ordered]@{ status = 'not-applicable'; detail = 'DNS role absent' } }`,
      `} else {`,
      `  $__sections.roleDetect = [ordered]@{ status = 'complete'; detail = 'DNS Server service present' }`,
      `  $__result.moduleAvailable = [bool](Get-Module -ListAvailable -Name DnsServer)`,
      `  if (-not $__result.moduleAvailable) {`,
      `    foreach ($n in 'zones','forwarders','scavenging') { $__sections[$n] = [ordered]@{ status = 'failed'; error = 'DnsServer module unavailable — install RSAT DNS tools' } }`,
      `    $__result.errors += 'DNS service present but DnsServer module unavailable — install RSAT DNS tools'`,
      `  } else {`,
      `    try { $__result.zones = @(Get-DnsServerZone -ErrorAction Stop | Select-Object ZoneName, ZoneType, IsDsIntegrated, IsReverseLookupZone, DynamicUpdate); $__sections.zones = [ordered]@{ status = 'complete'; count = $__result.zones.Count } } catch { $__sections.zones = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__result.errors += "zones: $($_.Exception.Message)" }`,
      `    try { $__result.forwarders = @((Get-DnsServerForwarder -ErrorAction Stop).IPAddress.IPAddressToString); $__sections.forwarders = [ordered]@{ status = 'complete'; count = $__result.forwarders.Count; note = 'empty list is authoritative — complete enumeration returned none' } } catch { $__sections.forwarders = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__result.errors += "forwarders: $($_.Exception.Message)" }`,
      `    try { $scav = Get-DnsServerScavenging -ErrorAction Stop; $__result.scavenging = [ordered]@{ enabled = [bool]$scav.ScavengingState; intervalHours = [string]$scav.ScavengingInterval }; $__sections.scavenging = [ordered]@{ status = 'complete' } } catch { $__sections.scavenging = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message } }`,
      `  }`,
      `}`,
      RB_JSON_FOOTER_V2,
    ].join('\n'),
    params: {},
    applicability: { os: ['windows-server'], powershell: '5.1+', roles: ['dns-server'], runAs: 'system' },
    classification: 'read',
    affectedScope: 'domain-wide name resolution config (read only)',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 120,
    outputLimits: { maxRows: 200, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 2 },
    preconditions: 'DNS Server role on the target (detected, not assumed)',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-24' },
  },
  {
    id: 'diag/dhcp-scopes',
    version: 2,
    title: 'DHCP scopes, options, utilization, failover (sectioned)',
    purpose: 'On a DHCP server: v4 scopes with free/used counts and options 003/006/015, failover relationships. Failover section failure is unverified, never absence. rolePresent:false on non-DHCP hosts.',
    category: 'diagnostic',
    script: [
      `$__result = [ordered]@{ rolePresent = $false; moduleAvailable = $false; scopes = @(); failover = @(); errors = @() }`,
      `$__sections = [ordered]@{}; $__native = [ordered]@{}`,
      `$__result.rolePresent = [bool](Get-Service -Name DHCPServer -ErrorAction SilentlyContinue)`,
      `if (-not $__result.rolePresent) {`,
      `  $__sections.roleDetect = [ordered]@{ status = 'complete'; detail = 'DHCPServer service absent — role not applicable' }`,
      `  foreach ($n in 'scopes','options','failover') { $__sections[$n] = [ordered]@{ status = 'not-applicable'; detail = 'DHCP role absent' } }`,
      `} else {`,
      `  $__sections.roleDetect = [ordered]@{ status = 'complete'; detail = 'DHCPServer service present' }`,
      `  $__result.moduleAvailable = [bool](Get-Module -ListAvailable -Name DhcpServer)`,
      `  if (-not $__result.moduleAvailable) {`,
      `    foreach ($n in 'scopes','options','failover') { $__sections[$n] = [ordered]@{ status = 'failed'; error = 'DhcpServer module unavailable — install RSAT DHCP tools' } }`,
      `    $__result.errors += 'DHCP service present but DhcpServer module unavailable — install RSAT DHCP tools'`,
      `  } else {`,
      `    try {`,
      `      $__result.scopes = @(Get-DhcpServerv4Scope -ErrorAction Stop | ForEach-Object {`,
      `        $stats = Get-DhcpServerv4ScopeStatistics -ScopeId $_.ScopeId -ErrorAction SilentlyContinue`,
      `        $opts = @{}`,
      `        try { foreach ($o in (Get-DhcpServerv4OptionValue -ScopeId $_.ScopeId -ErrorAction Stop)) { $opts[[string]$o.OptionId] = @($o.Value | ForEach-Object { [string]$_ }) } } catch { }`,
      `        [ordered]@{ scopeId = [string]$_.ScopeId; name = $_.Name; state = [string]$_.State; start = [string]$_.StartRange; end = [string]$_.EndRange; inUse = $stats.AddressesInUse; free = $stats.AddressesFree; pctUsed = if ($stats.PercentageInUse) { [math]::Round($stats.PercentageInUse,1) } else { $null }; options = $opts }`,
      `      })`,
      `      $__sections.scopes = [ordered]@{ status = 'complete'; count = $__result.scopes.Count; note = 'empty list is authoritative — complete enumeration returned none' }`,
      `      $__sections.options = [ordered]@{ status = 'complete'; detail = 'per-scope options embedded in scopes[].options' }`,
      `    } catch { $__sections.scopes = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__sections.options = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__result.errors += "scopes: $($_.Exception.Message)" }`,
      `    try { $__result.failover = @(Get-DhcpServerv4Failover -ErrorAction Stop | Select-Object Name, Mode, State, PartnerServer); $__sections.failover = [ordered]@{ status = 'complete'; count = $__result.failover.Count; note = 'empty list means no Windows failover relationship returned by this server — does not rule out other redundancy' } } catch { $__sections.failover = [ordered]@{ status = 'unverified'; error = [string]$_.Exception.Message } }`,
      `  }`,
      `}`,
      RB_JSON_FOOTER_V2,
    ].join('\n'),
    params: {},
    applicability: { os: ['windows-server'], powershell: '5.1+', roles: ['dhcp-server'], runAs: 'system' },
    classification: 'read',
    affectedScope: 'site/subnet address allocation config (read only)',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 120,
    outputLimits: { maxRows: 200, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 2 },
    preconditions: 'DHCP Server role on the target (detected, not assumed)',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-24' },
  },
  {
    id: 'diag/dhcp-scopes',
    version: 4,
    title: 'DHCP server authorization, scopes, options, failover (sectioned, budgeted transport)',
    purpose: 'On a DHCP server: AD authorization state (Get-DhcpServerInDC — a scope configured Active on an unauthorized server cannot serve), v4 scopes with options and raw statistics (inUse conflates reservations+leases — pair with diag/dhcp-clients for the split), failover. rolePresent:false on non-DHCP hosts.',
    category: 'diagnostic',
    script: [
      `$__result = [ordered]@{ rolePresent = $false; moduleAvailable = $false; authorizedInAd = $null; authorizedServers = @(); scopes = @(); failover = @(); errors = @() }`,
      `$__sections = [ordered]@{}; $__native = [ordered]@{}`,
      `$__result.rolePresent = [bool](Get-Service -Name DHCPServer -ErrorAction SilentlyContinue)`,
      `if (-not $__result.rolePresent) {`,
      `  $__sections.roleDetect = [ordered]@{ status = 'complete'; detail = 'DHCPServer service absent — role not applicable' }`,
      `  foreach ($n in 'scopes','options','failover','authorization') { $__sections[$n] = [ordered]@{ status = 'not-applicable'; detail = 'DHCP role absent' } }`,
      `} else {`,
      `  $__sections.roleDetect = [ordered]@{ status = 'complete'; detail = 'DHCPServer service present' }`,
      `  $__result.moduleAvailable = [bool](Get-Module -ListAvailable -Name DhcpServer)`,
      `  if (-not $__result.moduleAvailable) {`,
      `    foreach ($n in 'scopes','options','failover','authorization') { $__sections[$n] = [ordered]@{ status = 'failed'; error = 'DhcpServer module unavailable — install RSAT DHCP tools' } }`,
      `    $__result.errors += 'DHCP service present but DhcpServer module unavailable — install RSAT DHCP tools'`,
      `  } else {`,
      `    try {`,
      `      $__myFqdn = ([System.Net.Dns]::GetHostByName($env:COMPUTERNAME).HostName).ToLower()`,
      `      $__dc = @(Get-DhcpServerInDC -ErrorAction Stop)`,
      `      $__result.authorizedServers = @($__dc | ForEach-Object { [ordered]@{ dns = [string]$_.DnsName; ip = [string]$_.IPAddress } })`,
      `      $__result.authorizedInAd = [bool]($__dc | Where-Object { ([string]$_.DnsName).ToLower() -eq $__myFqdn })`,
      `      $__sections.authorization = [ordered]@{ status = 'complete'; count = $__dc.Count; detail = "this host ($__myFqdn) $(if ($__result.authorizedInAd) { 'IS' } else { 'is NOT' }) in the authorized list" }`,
      `    } catch { $__sections.authorization = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message } }`,
      `    try {`,
      `      $__result.scopes = @(Get-DhcpServerv4Scope -ErrorAction Stop | ForEach-Object {`,
      `        $stats = Get-DhcpServerv4ScopeStatistics -ScopeId $_.ScopeId -ErrorAction SilentlyContinue`,
      `        $opts = @{}`,
      `        try { foreach ($o in (Get-DhcpServerv4OptionValue -ScopeId $_.ScopeId -ErrorAction Stop)) { $opts[[string]$o.OptionId] = @($o.Value | ForEach-Object { [string]$_ }) } } catch { }`,
      `        [ordered]@{ scopeId = [string]$_.ScopeId; name = $_.Name; state = [string]$_.State; start = [string]$_.StartRange; end = [string]$_.EndRange; inUse = $stats.AddressesInUse; free = $stats.AddressesFree; pctUsed = if ($stats.PercentageInUse) { [math]::Round($stats.PercentageInUse,1) } else { $null }; options = $opts }`,
      `      })`,
      `      $__sections.scopes = [ordered]@{ status = 'complete'; count = $__result.scopes.Count; note = 'empty list is authoritative' }`,
      `      $__sections.options = [ordered]@{ status = 'complete'; detail = 'in scopes[].options' }`,
      `    } catch { $__sections.scopes = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__sections.options = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__result.errors += "scopes: $($_.Exception.Message)" }`,
      `    try { $__result.failover = @(Get-DhcpServerv4Failover -ErrorAction Stop | Select-Object Name, Mode, State, PartnerServer); $__sections.failover = [ordered]@{ status = 'complete'; count = $__result.failover.Count; note = 'empty means no Windows failover — other redundancy may exist' } } catch { $__sections.failover = [ordered]@{ status = 'unverified'; error = [string]$_.Exception.Message } }`,
      `  }`,
      `}`,
      RB_JSON_FOOTER_V3,
    ].join('\n'),
    params: {},
    applicability: { os: ['windows-server'], powershell: '5.1+', roles: ['dhcp-server'], runAs: 'system' },
    classification: 'read',
    affectedScope: 'site/subnet address allocation config (read only)',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 180,
    outputLimits: { maxRows: 200, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 3 },
    preconditions: 'DHCP Server role on the target (detected, not assumed); domain connectivity for authorization check',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-10-05' },
  },
  {
    id: 'diag/dhcp-clients',
    version: 1,
    title: 'DHCP per-scope reservations and leases (sectioned, budgeted transport)',
    purpose: 'On a DHCP server: per-scope reservations (Get-DhcpServerv4Reservation — configured permanent assignments, not live clients) and leases (Get-DhcpServerv4Lease — AddressState distinguishes Active/Inactive and *Reservation states). Volatile data — reflects collection instant. rolePresent:false on non-DHCP hosts.',
    category: 'diagnostic',
    script: [
      `$__result = [ordered]@{ rolePresent = $false; moduleAvailable = $false; scopes = @(); errors = @() }`,
      `$__sections = [ordered]@{}; $__native = [ordered]@{}`,
      `$__result.rolePresent = [bool](Get-Service -Name DHCPServer -ErrorAction SilentlyContinue)`,
      `if (-not $__result.rolePresent) {`,
      `  $__sections.roleDetect = [ordered]@{ status = 'complete'; detail = 'DHCPServer service absent — role not applicable' }`,
      `  foreach ($n in 'scopes','reservations','leases') { $__sections[$n] = [ordered]@{ status = 'not-applicable'; detail = 'DHCP role absent' } }`,
      `} else {`,
      `  $__sections.roleDetect = [ordered]@{ status = 'complete'; detail = 'DHCPServer service present' }`,
      `  $__result.moduleAvailable = [bool](Get-Module -ListAvailable -Name DhcpServer)`,
      `  if (-not $__result.moduleAvailable) {`,
      `    foreach ($n in 'scopes','reservations','leases') { $__sections[$n] = [ordered]@{ status = 'failed'; error = 'DhcpServer module unavailable — install RSAT DHCP tools' } }`,
      `    $__result.errors += 'DHCP service present but DhcpServer module unavailable — install RSAT DHCP tools'`,
      `  } else {`,
      `    $__resErr = $false; $__leaseErr = $false; $__resTrunc = $false; $__leaseTrunc = $false`,
      `    try {`,
      `      $__result.scopes = @(Get-DhcpServerv4Scope -ErrorAction Stop | ForEach-Object {`,
      `        $__resv = @()`,
      `        try { $__allResv = @(Get-DhcpServerv4Reservation -ScopeId $_.ScopeId -ErrorAction Stop); if ($__allResv.Count -gt 500) { $__resTrunc = $true }; $__resv = @($__allResv | Select-Object -First 500 | ForEach-Object { [ordered]@{ ip = [string]$_.IPAddress; clientId = [string]$_.ClientId; name = [string]$_.Name; type = [string]$_.Type } }) } catch { $__resErr = $true }`,
      `        $__lease = @()`,
      `        try { $__allLease = @(Get-DhcpServerv4Lease -ScopeId $_.ScopeId -ErrorAction Stop -AllLeases); if ($__allLease.Count -gt 500) { $__leaseTrunc = $true }; $__lease = @($__allLease | Select-Object -First 500 | ForEach-Object { [ordered]@{ ip = [string]$_.IPAddress; clientId = [string]$_.ClientId; hostName = [string]$_.HostName; state = [string]$_.AddressState; expiry = if ($_.LeaseExpiryTime) { [string]$_.LeaseExpiryTime } else { $null } } }) } catch { $__leaseErr = $true }`,
      `        [ordered]@{ scopeId = [string]$_.ScopeId; reservedCount = $__resv.Count; leasedCount = $__lease.Count; reservations = $__resv; leases = $__lease }`,
      `      })`,
      `      $__sections.scopes = [ordered]@{ status = 'complete'; count = $__result.scopes.Count; note = 'enumeration frame only — scope entities are owned by diag/dhcp-scopes' }`,
      `      $__sections.reservations = [ordered]@{ status = $(if ($__resErr) { 'partial' } else { 'complete' }); count = @($__result.scopes | ForEach-Object { $_.reservations.Count } | Measure-Object -Sum).Sum; truncated = $__resTrunc; note = 'reservations are configured permanent assignments — not live clients' }`,
      `      $__sections.leases = [ordered]@{ status = $(if ($__leaseErr) { 'partial' } else { 'complete' }); count = @($__result.scopes | ForEach-Object { $_.leases.Count } | Measure-Object -Sum).Sum; truncated = $__leaseTrunc; note = 'AddressState distinguishes Active/Inactive and *Reservation states — volatile data, reflects collection instant' }`,
      `    } catch { $__sections.scopes = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__sections.reservations = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__sections.leases = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__result.errors += "scopes: $($_.Exception.Message)" }`,
      `  }`,
      `}`,
      RB_JSON_FOOTER_V3,
    ].join('\n'),
    params: {},
    applicability: { os: ['windows-server'], powershell: '5.1+', roles: ['dhcp-server'], runAs: 'system' },
    classification: 'read',
    affectedScope: 'DHCP client state on the target server (read only)',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 240,
    outputLimits: { maxRows: 200, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 3 },
    preconditions: 'DHCP Server role on the target (detected, not assumed)',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-10-05' },
  },
  {
    id: 'diag/dns-records',
    version: 1,
    title: 'DNS per-zone records and aging (sectioned, budgeted transport)',
    purpose: 'On a DNS server (usually a DC): per-zone resource records with normalized data, timestamps, TTL, and static/dynamic flag (drives stale-record analysis — records with old timestamps persist when scavenging is off), plus per-zone aging config. Shape converges on the Solve4x checkpoint audit format. rolePresent:false on non-DNS hosts.',
    category: 'diagnostic',
    script: [
      `$__result = [ordered]@{ rolePresent = $false; moduleAvailable = $false; zones = @(); errors = @() }`,
      `$__sections = [ordered]@{}; $__native = [ordered]@{}`,
      `$__result.rolePresent = [bool](Get-Service -Name DNS -ErrorAction SilentlyContinue)`,
      `if (-not $__result.rolePresent) {`,
      `  $__sections.roleDetect = [ordered]@{ status = 'complete'; detail = 'DNS service absent' }`,
      `  $__sections.records = [ordered]@{ status = 'not-applicable'; detail = 'not applicable — DNS role absent' }`,
      `} else {`,
      `  $__sections.roleDetect = [ordered]@{ status = 'complete'; detail = 'DNS service present' }`,
      `  $__result.moduleAvailable = [bool](Get-Module -ListAvailable -Name DnsServer)`,
      `  if (-not $__result.moduleAvailable) {`,
      `    $__sections.records = [ordered]@{ status = 'failed'; error = 'DnsServer module unavailable' }`,
      `    $__result.errors += 'DNS service present but DnsServer module unavailable'`,
      `  } else {`,
      `    $__recErr = $false; $__anyTrunc = $false; $__totRec = 0`,
      `    $__map = @{ A = 'IPv4Address.IPAddressToString'; AAAA = 'IPv6Address.IPAddressToString'; CNAME = 'HostNameAlias'; NS = 'NameServer'; PTR = 'PtrDomainName'; TXT = 'DescriptiveText' }`,
      `    $__allZ = @()`,
      `    try { $__allZ = @(Get-DnsServerZone -ErrorAction Stop | Select-Object -First 60) } catch { $__recErr = $true; $__result.errors += "zones: $($_.Exception.Message)" }`,
      `    $__result.zones = @($__allZ | ForEach-Object {`,
      `      $__zn = [string]$_.ZoneName`,
      `      $__ag = $null`,
      `      try { $__ag = [bool](Get-DnsServerZoneAging -Name $__zn -ErrorAction Stop).AgingEnabled } catch { $__recErr = $true }`,
      `      $__recs = @(); $__zTrunc = $false`,
      `      try {`,
      `        $__allR = @(Get-DnsServerResourceRecord -ZoneName $__zn -ErrorAction Stop)`,
      `        if ($__allR.Count -gt 1000) { $__zTrunc = $true; $__anyTrunc = $true }`,
      `        $__recs = @($__allR | Select-Object -First 1000 | ForEach-Object {`,
      `          $__rt = [string]$_.RecordType; $__d = $null`,
      `          if ($__map.Contains($__rt)) { $__v = $_.RecordData; foreach ($__k in $__map[$__rt].Split('.')) { $__v = $__v.$__k }; $__d = [string]$__v }`,
      `          elseif ($__rt -eq 'MX') { $__d = "$($_.RecordData.MailExchange) pref=$($_.RecordData.Preference)" }`,
      `          elseif ($__rt -eq 'SRV') { $__d = "$($_.RecordData.DomainName) port=$($_.RecordData.Port)" }`,
      `          elseif ($__rt -eq 'SOA') { $__d = "$($_.RecordData.PrimaryServer) serial=$($_.RecordData.SerialNumber)" }`,
      `          if ($__d.Length -gt 200) { $__d = $__d.Substring(0,200) }`,
      `          [ordered]@{ host = [string]$_.HostName; type = $__rt; ts = $(if ($_.Timestamp.Year -gt 1900) { $_.Timestamp.ToString('o') }); ttl = [string]$_.TimeToLive; data = $__d }`,
      `        })`,
      `      } catch { $__recErr = $true }`,
      `      $__totRec += $__recs.Count`,
      `      [ordered]@{ name = $__zn; truncated = $__zTrunc; aging = $__ag; records = $__recs }`,
      `    })`,
      `    $__sections.records = [ordered]@{ status = $(if ($__recErr) { 'partial' } else { 'complete' }); count = $__totRec; truncated = $__anyTrunc; note = 'per-type data; ts null=static; aging included' }`,
      `  }`,
      `}`,
      RB_JSON_FOOTER_V3,
    ].join('\n'),
    params: {},
    applicability: { os: ['windows-server'], powershell: '5.1+', roles: ['dns-server'], runAs: 'system' },
    classification: 'read',
    affectedScope: 'DNS zone contents on the target server (read only)',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 300,
    outputLimits: { maxRows: 200, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 3 },
    preconditions: 'DNS Server role on the target (detected, not assumed)',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-10-05' },
  },
  {
    id: 'diag/gpo-inventory',
    version: 2,
    title: 'Group Policy inventory, status, and links (sectioned)',
    purpose: 'Domain GPOs with section status plus link targets (SOM paths) from Get-GPOReport. Exists/configured-scope/observed-application remain distinct — application is never inferred.',
    category: 'diagnostic',
    script: [
      `$__result = [ordered]@{ domainJoined = $false; moduleAvailable = $false; gpos = @(); links = @{}; total = 0; errors = @() }`,
      `$__sections = [ordered]@{}; $__native = [ordered]@{}`,
      `$__result.domainJoined = [bool]((Get-CimInstance Win32_ComputerSystem).PartOfDomain)`,
      `if (-not $__result.domainJoined) {`,
      `  $__sections.domainCheck = [ordered]@{ status = 'complete'; detail = 'endpoint is not domain-joined' }`,
      `  foreach ($n in 'inventory','links') { $__sections[$n] = [ordered]@{ status = 'not-applicable'; detail = 'not domain-joined' } }`,
      `} else {`,
      `  $__sections.domainCheck = [ordered]@{ status = 'complete'; detail = 'domain-joined' }`,
      `  $__result.moduleAvailable = [bool](Get-Module -ListAvailable -Name GroupPolicy)`,
      `  if (-not $__result.moduleAvailable) {`,
      `    foreach ($n in 'inventory','links') { $__sections[$n] = [ordered]@{ status = 'failed'; error = 'GroupPolicy module unavailable — run on a DC or install RSAT GPMC tools' } }`,
      `    $__result.errors += 'GroupPolicy module unavailable — run on a DC or install RSAT GPMC tools'`,
      `  } else {`,
      `    try {`,
      `      $all = @(Get-GPO -All -ErrorAction Stop | Select-Object DisplayName, Id, GpoStatus, CreationTime, ModificationTime)`,
      `      $__result.total = $all.Count`,
      `      $__result.gpos = @($all | Select-Object -First 200)`,
      `      $__sections.inventory = [ordered]@{ status = 'complete'; count = $all.Count; truncated = ($all.Count -gt 200) }`,
      `    } catch { $__sections.inventory = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__result.errors += "inventory: $($_.Exception.Message)" }`,
      `    try {`,
      `      [xml]$report = Get-GPOReport -All -ReportType Xml -ErrorAction Stop`,
      `      $linksMap = [ordered]@{}`,
      `      $count = 0`,
      `      foreach ($g in @($report.GPOs.GPO)) {`,
      `        if ($count -ge 150) { break }`,
      `        $count++`,
      `        $guid = ([string]$g.Identifier.Identifier.InnerText).Trim('{}')`,
      `        $linksMap[$guid] = @($g.LinksTo | ForEach-Object { [ordered]@{ som = [string]$_.SOMPath; somName = [string]$_.SOMName; enabled = [bool]$_.Enabled; noOverride = [bool]$_.NoOverride } })`,
      `      }`,
      `      $__result.links = $linksMap`,
      `      $__sections.links = [ordered]@{ status = 'complete'; count = $count; truncated = (@($report.GPOs.GPO).Count -gt 150) }`,
      `    } catch { $__sections.links = [ordered]@{ status = 'failed'; error = [string]$_.Exception.Message }; $__result.errors += "links: $($_.Exception.Message)" }`,
      `  }`,
      `}`,
      RB_JSON_FOOTER_V2,
    ].join('\n'),
    params: {},
    applicability: { os: ['windows'], powershell: '5.1+', roles: ['domain-controller', 'rsat-host'], runAs: 'system' },
    classification: 'read',
    affectedScope: 'domain-wide policy set (read only)',
    sideEffects: 'none',
    disruption: 'none',
    timeoutSeconds: 180,
    outputLimits: { maxRows: 200, maxChars: 8000 },
    retry: 'safe',
    resultSchema: { parser: 'rbjson', version: 2 },
    preconditions: 'domain-joined host with GroupPolicy module (detected, not assumed)',
    postconditions: 'none — read-only',
    recovery: 'n/a — no changes made',
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-09-24' },
  },
];

/*
 * v3 — identical collection bodies; only the emission footer differs
 * (RBJGZ fallback under the ~10K activity-channel cap). Derived
 * programmatically so the reviewed v2 measurement logic can never drift
 * from v3 — the swap is provable: v3.script === v2.script with the footer
 * replaced. Extraction is unchanged: the payload shape is identical.
 */
for (const id of ['diag/ad-health', 'diag/dns-server', 'diag/dhcp-scopes', 'diag/gpo-inventory']) {
  const v2 = RUNBOOKS.find((r) => r.id === id && r.version === 2);
  if (!v2) continue;
  RUNBOOKS.push({
    ...v2,
    version: 3,
    title: v2.title.replace('(sectioned)', '(sectioned, budgeted transport)'),
    script: v2.script.replace(RB_JSON_FOOTER_V2, () => RB_JSON_FOOTER_V3),
    resultSchema: { parser: 'rbjson', version: 3 },
    review: { status: 'reviewed', reviewedBy: 'solve4x', reviewedAt: '2026-10-05' },
  });
}

export function listRunbooks(filter?: { category?: string | undefined; query?: string | undefined }): Runbook[] {
  let list = RUNBOOKS.filter((r) => !r.revoked);
  if (filter?.category) list = list.filter((r) => r.category === filter.category);
  const q = filter?.query?.trim().toLowerCase();
  if (q) list = list.filter((r) => `${r.id} ${r.title} ${r.purpose}`.toLowerCase().includes(q));
  return list;
}

export function getRunbook(id: string, version?: number): Runbook {
  const matches = RUNBOOKS.filter((r) => r.id === id && (version === undefined || r.version === version));
  if (matches.length === 0) throw new RunbookError('runbook_not_found', `Runbook ${id}${version !== undefined ? ` v${version}` : ''} not found`);
  const rb = matches.sort((a, b) => b.version - a.version)[0]!;
  if (rb.revoked) throw new RunbookError('runbook_revoked', `Runbook ${rb.id} v${rb.version} is revoked: ${rb.revoked}`);
  return rb;
}

/** Compact catalog row for model-facing list responses. */
export function summarizeRunbook(rb: Runbook): Record<string, unknown> {
  return {
    id: rb.id,
    version: rb.version,
    digest: scriptDigest(rb.script),
    title: rb.title,
    purpose: rb.purpose,
    category: rb.category,
    classification: rb.classification,
    disruption: rb.disruption,
    timeoutSeconds: rb.timeoutSeconds,
    paramNames: Object.entries(rb.params).map(([name, p]) => ({ name, type: p.type, required: !!p.required, default: p.default })),
    applicability: rb.applicability,
  };
}

/**
 * Validate caller params against the runbook schema and return the resolved
 * parameter object (defaults applied). Throws RunbookError('invalid_params').
 */
export function validateParams(rb: Runbook, params: Record<string, unknown> | undefined): Record<string, unknown> {
  const input = params ?? {};
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const key of Object.keys(input)) {
    if (!(key in rb.params)) problems.push(`unknown param "${key}"`);
  }
  for (const [name, spec] of Object.entries(rb.params)) {
    let value = input[name];
    if (value === undefined || value === null) {
      if (spec.required && spec.default === undefined) {
        problems.push(`missing required param "${name}"`);
        continue;
      }
      value = spec.default ?? null;
    }
    if (value === null) {
      out[name] = null;
      continue;
    }
    switch (spec.type) {
      case 'string':
        if (typeof value !== 'string') { problems.push(`"${name}" must be a string`); continue; }
        if (spec.maxLength && value.length > spec.maxLength) { problems.push(`"${name}" exceeds ${spec.maxLength} chars`); continue; }
        if (spec.pattern && !new RegExp(`^(?:${spec.pattern})$`).test(value)) { problems.push(`"${name}" fails pattern ${spec.pattern}`); continue; }
        break;
      case 'integer':
        if (!Number.isInteger(Number(value))) { problems.push(`"${name}" must be an integer`); continue; }
        value = Number(value);
        if (spec.min !== undefined && (value as number) < spec.min) { problems.push(`"${name}" < ${spec.min}`); continue; }
        if (spec.max !== undefined && (value as number) > spec.max) { problems.push(`"${name}" > ${spec.max}`); continue; }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') { problems.push(`"${name}" must be a boolean`); continue; }
        break;
      case 'enum':
        if (typeof value !== 'string' || !spec.enum?.includes(value)) { problems.push(`"${name}" must be one of [${(spec.enum ?? []).join(', ')}]`); continue; }
        break;
    }
    out[name] = value;
  }
  if (problems.length > 0) throw new RunbookError('invalid_params', `Runbook ${rb.id} params rejected: ${problems.join('; ')}`);
  return out;
}

/**
 * Resolve a runbook + params into the exact PowerShell text that will run.
 * Params are bound as DATA: a base64-JSON blob decoded into $__p — values
 * can never become executable text (base64 alphabet excludes the quote).
 */
export function resolveRunbookScript(
  rb: Runbook,
  params: Record<string, unknown> | undefined,
): { command: string; params: Record<string, unknown>; digest: string } {
  const resolved = validateParams(rb, params);
  const paramsB64 = Buffer.from(JSON.stringify(resolved), 'utf8').toString('base64');
  const command =
    `$__p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${paramsB64}')) | ConvertFrom-Json\n` +
    rb.script;
  return { command, params: resolved, digest: scriptDigest(rb.script) };
}

/**
 * Extract the runbook's structured result from captured stdout.
 * Returns null when no RBJSON line exists — malformed output stays raw
 * (execution success ≠ parser success; plan §7).
 */
export function parseRunbookResult(stdout: string | null): Record<string, unknown> | null {
  if (!stdout) return null;
  // v3 payloads may be gzip+base64 (RBJGZ) when the result exceeds the
  // activity-channel size cap — same JSON, different wire encoding.
  const gz = stdout.lastIndexOf('RBJGZ:');
  const js = stdout.lastIndexOf('RBJSON:');
  const idx = Math.max(gz, js);
  if (idx < 0) return null;
  const line = stdout.slice(idx + (idx === gz ? 'RBJGZ:'.length : 'RBJSON:'.length)).split('\n')[0]?.trim();
  if (!line) return null;
  try {
    const text = idx === gz ? gunzipSync(Buffer.from(line, 'base64')).toString('utf8') : line;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
