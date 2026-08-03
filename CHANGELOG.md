# Changelog

## 2026-08-03

### Fixed
- Unleashed rejects percent-encoded colons in the signed query string with a bare HTTP 403, so every request carrying `modifiedSince` was failing while parameter-free requests succeeded. The reconcile timer had been dead — the webhook path masked it, since it looks products up by Guid. Colons are now sent raw. Found within minutes of the new daily report going live, by the report itself.

### Added
- `weeklyAudit` timer (Sun 22:30 UTC / Mon 08:30 AEST): whole-catalogue audit of Unleashed products that hold images but have no matching Shopify SKU — photographed stock no shopper can ever see. The daily report cannot find these because it only looks at the last 24 hours. First run: 195 products, 18 of them likely SKU typos with a suggested match, 2 SKUs on more than one Shopify product.
- The full unmatched list attaches as `unmatched-skus.csv`, and `scripts/sync-cli.js --audit [--csv <path>]` runs the same audit on demand.
- Zero-activity alert: a day with no Unleashed changes is re-checked against `ZERO_ACTIVITY_PROBE_DAYS` (7). Silent for a day is a quiet day; silent for a week means the sync has stopped seeing Unleashed.
- `shopify.listAllVariantSkus()` and `unleashed.countProductsModifiedSince()`.

### Changed
- Reports are delivered by email through Resend — the sender `searay-email-func` already uses — instead of Slack. Recipients come from `EMAIL_TO` and change without a redeploy. Report bodies are now plain text plus table-based HTML that survives Outlook, with all Unleashed free text escaped.

### Removed
- `SLACK_WEBHOOK_URL` and the Slack delivery path.

## 2026-07-31 (evening)

### Added
- `dailyReport` timer function (22:00 UTC / 08:00 AEST): re-verifies the last 24 hours in dry-run mode and reports health. Anything still pending means the live sync failed or fell behind — otherwise invisible, since a broken sync looks like a quiet day. `dryRun` is forced on so the reporting job can never become a second writer.
- Health verdict rules: any failure alerts, pending beyond `PENDING_WARN_THRESHOLD` warns, unmatched and capped counts are reported but never alert.
- Optional Slack delivery via `SLACK_WEBHOOK_URL`; without it the summary still reaches Application Insights, and a delivery failure never breaks the sync.
- GitHub Actions CI: module parse check, the offline test suite, a Functions-host load check for every trigger, and a guard that fails if a Shopify token or `local.settings.json` is ever committed.

## 2026-07-31 (later)

### Added
- `MAX_MEDIA_PER_PRODUCT` (default 5) — ceiling on total images on one Shopify product, counting media the sync did not add. Agreed with Christina: "5 per unleashed product, cap each web page at 5 as well".
- Images beyond the cap are skipped and reported per product in the run result and logs, never dropped silently. Because images are ordered default-first, the default image is the one that survives the cut.
- `mediaOnPage` in the sync result, so reports show how full a product already was.

## 2026-07-31

### Added
- Deployed to Azure Function App `searay-unleashed-sync` (resource group `searay-func-rg`, australiaeast, Linux consumption, Node 22) with storage account `searayunleashedsync`.
- Registered the Unleashed webhook subscription `51295e09-4053-4d02-a618-a25f2ff01bec` for `product.created` / `product.updated`.
- `scripts/deploy.sh` — idempotent create-and-publish, resolving the Core Tools binary rather than assuming it is on PATH.
- `scripts/push-settings.py` — pushes app settings via a temp file so values never reach the process list or terminal.
- `scripts/import-token.py` — copies an existing Shopify token from the legacy C# sync projects without displaying it.
- `RECONCILE_MAX_PAGES` is now configurable; the default of 25 would have silently truncated a whole-catalogue pass at ~33 pages.

### Changed
- `DRY_RUN=true` in the deployed app pending a decision on the per-page image ceiling. The reconcile timer runs and reports but changes nothing.
- `scripts/register-webhook.js` writes the returned `signatureKey` straight into `local.settings.json` instead of printing it, and refuses to create a duplicate subscription for a URL that already has one.

## 2026-07-30

### Fixed
- Scoped media ownership per Unleashed product code, since several Unleashed products share one Shopify product when alloy/size are variant options. Previously siblings overwrote each other's state, and with deletion enabled would have detached each other's images on alternate runs.
- Suppressed reordering when a sibling Unleashed product owns media on the same Shopify product.
- Stopped re-issuing a reorder mutation on every pass when the media order was already correct.

### Added
- Unleashed → Shopify product media sync service (Azure Functions v4, Node).
- `unleashedWebhook` HTTP trigger with HMAC-SHA256 verification of `{timestamp}.{body}` and a 5-minute freshness window.
- `reconcileMedia` timer trigger running every 10 minutes over an overlapping `modifiedSince` window.
- `backfillMedia` HTTP trigger (function key) supporting `?sku=`, `?since=`, `?all=true`, `&limit=`, `&dryRun=true`.
- Adoption of existing Shopify media by filename so the image Unleashed's built-in connector already pushed is claimed instead of duplicated.
- Ownership tracking in the `custom.unleashed_media` product metafield; only tracked media is ever removable.
- `scripts/sync-cli.js` for local runs and `scripts/register-webhook.js` for subscription setup.
- `scripts/self-test.js` covering image identity, plan decisions, request signing and webhook verification.
