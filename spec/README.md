# Pinned NinjaOne API specification

`NinjaRMM-API-v2.json` is a local, discovery-only copy of NinjaOne's official
OpenAPI document. The MCP server can search and describe this catalog, but it
cannot execute catalog entries.

Pinned source:

- URL: `https://us2.ninjarmm.com/apidocs/NinjaRMM-API-v2.json`
- API version: `2.0.9-draft`
- SHA-256: `5932b93aea2a65bd6f3df734f80afdaaa0ac6ccf2672c67a25780eec22f79f0d`
- Retrieved: `2026-10-03` (NinjaOne 15.1: +5 operations — knowledge base article reads, system custom fields, device geolocation history)

Updates are intentionally manual. Download a candidate outside this directory,
review the endpoint and method changes, then run
`scripts/update-api-spec.ps1 -CandidatePath <path> -ApproveHash <sha256>`.
Restart the MCP processes only after the new hash and version are recorded here.

