# Pinned NinjaOne API specification

`NinjaRMM-API-v2.json` is a local, discovery-only copy of NinjaOne's official
OpenAPI document. The MCP server can search and describe this catalog, but it
cannot execute catalog entries.

Pinned source:

- URL: `https://app.ninjarmm.com/apidocs/NinjaRMM-API-v2.json`
- API version: `2.0.9-draft`
- SHA-256: `753f26d4665028bf284975df632effa4fdd7318637a6270e020bfa8056b55c9d`
- Retrieved: `2026-07-28`

Updates are intentionally manual. Download a candidate outside this directory,
review the endpoint and method changes, then run
`scripts/update-api-spec.ps1 -CandidatePath <path> -ApproveHash <sha256>`.
Restart the MCP processes only after the new hash and version are recorded here.

