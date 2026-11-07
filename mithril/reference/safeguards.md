# Conditional runtime safeguards

Read only sections matching the change. Use applicable existing scans/reviews; report unavailable checks, never imply coverage.

## Shared state, remote calls, and caches

Prefer immutable/local state; protect shared invariants. Bound remote waits, support cancellation, and retry safely/idempotently. Avoid N+1 calls/repeated scans; batch where supported. Measure before optimizing; bound caches and define invalidation.

## Persistence

Transactions cover the business operation. Protect read-modify-write; release resources on every path. Keep network/user waits outside transactions. Bound/index queries; enforce authorization scope before fetching, not by filtering afterward.

## Delivery

Preserve old/new compatibility for APIs, schemas, and config. Use expand-contract, safe defaults or explicit startup failure, and a verified rollback path.

## Operational paths

Make new/changed failures detectable and diagnosable: safe structured logs, correlation across boundaries, and relevant latency/error/queue signals. Include security events without sensitive payloads.
