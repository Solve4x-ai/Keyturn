# Security policy

Keyturn sits between an AI assistant and real endpoints, so security
reports get priority.

## Reporting a vulnerability

**Please don't open a public issue.** Use GitHub's private reporting:
**[Report a vulnerability](https://github.com/Solve4x-ai/Keyturn/security/advisories/new)**,
or email **[support@solve4x.ai](mailto:support@solve4x.ai)** with "Security" in
the subject.

Include what you can: affected version or commit, steps to reproduce, and the
impact you see. You'll get an acknowledgement within a few business days and a
fix or mitigation plan once the issue is confirmed. We're happy to credit you
in the advisory.

## Supported versions

Security fixes land on `main` and in the next release. Only the latest release
is supported.

## Scope

Especially interesting:

- Any path that lets an endpoint action run **without** a human approval, or
  with an approval that doesn't match the plan hash.
- Bypassing passkey (WebAuthn) enforcement once a key is enrolled.
- Crossing organization allowlists or policy switches.
- Credential or token disclosure (env files, refresh tokens, serve token,
  logs, journal).
- Reaching the local UI / API from anything other than loopback, or without
  the bearer token.

Out of scope: attacks that already require full control of the operator's
Windows account (that is the documented trust boundary — see
[docs/security-model.md](docs/security-model.md#known-limits)), and issues in
NinjaOne itself (report those to NinjaOne).

## Never share secrets

Don't include real client IDs, secrets, tokens, tenant names, or device data in
reports, issues, or pull requests. Use the demo data (`npm run demo`) to
reproduce whenever possible.
