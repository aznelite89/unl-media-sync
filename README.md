# unleashed-media-sync

Syncs up to **5 product images** from Unleashed into Shopify **product media**, without
clobbering images added by hand in Shopify.

Unleashed's built-in Shopify connector syncs only the *default* image and replaces product
media when it runs, which wipes images uploaded directly into Shopify. This service replaces
that behaviour for images.

## Emergency stop

If anything looks wrong, put the sync into dry-run mode. It keeps running and keeps reporting,
but stops writing to Shopify. Takes effect within a few seconds — the app restarts on a settings
change — and needs no redeploy.

```bash
az functionapp config appsettings set -g searay-func-rg -n searay-unleashed-sync \
  --settings DRY_RUN=true -o none
```

Resume with the same command and `DRY_RUN=false`.

This does **not** undo anything already synced. To remove an image the sync added, delete it
from the product in Shopify admin; the sync will not put it back unless that product's entry is
also cleared from its `custom.unleashed_media` metafield.

## Why this is a separate service

Nothing here belongs in the theme repo (`Shopify/searay-theme-live`) — it never renders. It is
also deliberately **not** inside the existing `searay-email-func` Function App: that app serves
the live backorder email path, an Azure Function App has a single runtime stack, and a polling
job that hammers two external APIs shouldn't share a process with checkout-adjacent email.

It is **not** a Shopify App Store app either. It is server-to-server against one store, so a
Shopify **custom app** token is all it needs — no OAuth, no App Bridge, no embedded admin UI.

## How it decides what to do

For each Unleashed product:

1. `Images[]` is ordered **default first**, then Unleashed's own order, capped at `MAX_SYNCED_IMAGES`.
2. The Unleashed `ProductCode` is matched to a Shopify product via **variant SKU** (exact match,
   re-checked client-side because Shopify's search is fuzzy).
3. Existing state is read from the product metafield `custom.unleashed_media` — the record of
   **which media this service owns**.
4. Each Unleashed image resolves to one of:
   - **tracked** — already synced, nothing to do;
   - **adopted** — untracked, but existing Shopify media has the same filename, so it is claimed
     rather than duplicated (this is what stops the first run doubling up the image Unleashed's
     own connector already pushed — Shopify keeps the original basename and appends `_<uuid>`);
   - **upload** — appended via `productUpdate`, one image per call so each new media id can be
     mapped back to its Unleashed URL.
5. State is written back to the metafield.

### Guarantees

- **Media this service did not add is never removed, detached or replaced.** Only entries in
  `custom.unleashed_media` are ever candidates for removal.
- Removal additionally requires `DELETE_REMOVED_MEDIA=true` (**off by default**). When off, an
  image dropped in Unleashed stays in Shopify and is reported.
- Removal **detaches** the file from the product (`fileUpdate` + `referencesToRemove`); it does
  not delete the file from Files.
- Reordering is **skipped** when the product has any media this service didn't add, so a hero
  image someone deliberately positioned is never pushed down.
- Re-running is safe. Every decision is a diff against live Shopify state, so duplicate webhook
  deliveries and overlapping reconcile windows are no-ops.

### Many Unleashed products → one Shopify product

On this store, alloy and size are Shopify **variant options**, so several Unleashed
products routinely resolve to a single Shopify product. Confirmed live: `18K101-3`, `-4`,
`-5`, `-6`, `-7` and `-10` all resolve to `gid://shopify/Product/8225786200217`.

Those siblings therefore **share one `custom.unleashed_media` metafield**, so every entry
records the `productCode` that created it:

```json
{ "version": 1, "syncedAt": "…", "managed": [
  { "url": "https://unlappcdn…/d40d…png", "mediaId": "gid://shopify/MediaImage/368…",
    "origin": "synced", "isDefault": true, "productCode": "18KBA15858X48" }
]}
```

Consequences, all enforced in `planMediaChanges`:

- An image is **resolved** against entries from any product code — if a sibling already put
  that file on the product, it is reused rather than uploaded twice.
- Only entries owned by the **current** product code are detach candidates. Without this,
  syncing `-4` would detach `-3`'s image and the siblings would destroy each other's images
  on alternate runs.
- Writing state **preserves** sibling entries instead of overwriting them.
- Reordering is skipped when a sibling owns media here, otherwise each sibling would shove
  its own images to the front on every run.

**Open question for the business:** `MAX_SYNCED_IMAGES` is 5 *per Unleashed product code*.
A Shopify product grouping 6 Unleashed products can therefore accumulate up to 30 media.
If the intent is 5 per *Shopify product*, that needs a different rule — see Known limits.

## Setup

### 1. Unleashed API credentials

Unleashed → **Integration → Unleashed API Access** → API ID and API Key.
→ `UNLEASHED_API_ID`, `UNLEASHED_API_KEY`

### 2. Shopify custom app

Shopify admin → **Settings → Apps and sales channels → Develop apps → Create an app**.
Admin API scopes required:

| Scope | Used for |
|---|---|
| `read_products`, `write_products` | find product by SKU, append media, reorder, write the state metafield |
| `read_files`, `write_files` | detach media from a product (`fileUpdate`) |

Install the app, reveal the **Admin API access token** (`shpat_…`) → `SHOPIFY_ADMIN_TOKEN`.

### 3. Turn off image sync in Unleashed's own connector

**Required, or the two will fight.** Unleashed → **eCommerce Hub → Shopify → Configure →
Product Synchronization → Advanced Settings** → turn the product **image** toggle off. Leave the
rest of product sync alone.

### 4. Local run

```bash
cp local.settings.json.example local.settings.json   # then fill in the secrets
npm install

node scripts/self-test.js                            # offline logic checks, no credentials needed

node scripts/sync-cli.js --sku 9KCH37145CM --dry-run # prove one product, write nothing
node scripts/sync-cli.js --sku 9KCH37145CM           # then for real
node scripts/sync-cli.js --since 2026-07-01 --limit 25
node scripts/sync-cli.js --all                       # whole catalogue backfill
```

`local.settings.json` is gitignored. Never commit a token.

### 5. Deploy to Azure

```bash
brew install azure-cli azure-functions-core-tools@4
az login

RG=searay-func-rg
APP=searay-unleashed-sync
STORAGE=searayunleashedsync          # 3-24 chars, lowercase alphanumeric only

az storage account create -n $STORAGE -g $RG --sku Standard_LRS
az functionapp create -g $RG -n $APP \
  --storage-account $STORAGE \
  --consumption-plan-location australiaeast \
  --runtime node --runtime-version 22 --functions-version 4 --os-type Linux

az functionapp config appsettings set -g $RG -n $APP --settings \
  UNLEASHED_API_ID="…" UNLEASHED_API_KEY="…" \
  SHOPIFY_STORE_DOMAIN="for-discovery.myshopify.com" SHOPIFY_ADMIN_TOKEN="shpat_…" \
  MAX_SYNCED_IMAGES=5 DELETE_REMOVED_MEDIA=false REORDER_MEDIA=true DRY_RUN=false

func azure functionapp publish $APP
```

Secrets belong in app settings (or Key Vault references) — never in the repo, and never in
anything the theme renders.

### 6. Register the webhook (after deploying)

```bash
node scripts/register-webhook.js \
  https://searay-unleashed-sync.azurewebsites.net/api/unleashed/product-webhook
```

Copy the returned `signatureKey` — **shown once** — into the app setting
`UNLEASHED_WEBHOOK_SIGNATURE_KEY`. Until it is set, the endpoint rejects every delivery.

## Endpoints and schedule

| Function | Trigger | Purpose |
|---|---|---|
| `unleashedWebhook` | `POST /api/unleashed/product-webhook` (anonymous, HMAC-verified) | near-real-time sync on `product.created` / `product.updated` |
| `reconcileMedia` | timer, every 10 min | re-reads the last `RECONCILE_LOOKBACK_MINUTES` — covers dropped deliveries and downtime |
| `backfillMedia` | `GET|POST /api/unleashed/backfill` (function key) | operator runs: `?sku=`, `?since=YYYY-MM-DD`, `?all=true`, `&limit=`, `&dryRun=true` |

The webhook route is anonymous on purpose: authenticity comes from the HMAC signature over
`{timestamp}.{body}`, which — unlike a key in the URL — cannot leak via logs or referrers.
Deliveries older than 5 minutes are rejected.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `MAX_SYNCED_IMAGES` | `5` | ceiling on images pushed per Unleashed product |
| `MAX_MEDIA_PER_PRODUCT` | `5` | ceiling on TOTAL images on one Shopify product, counting media the sync did not add. Uploads beyond it are skipped and reported; nothing is ever removed to make room |
| `DELETE_REMOVED_MEDIA` | `false` | detach media this service added once Unleashed no longer lists it |
| `REORDER_MEDIA` | `true` | order synced media default-first (skipped if manual media is present) |
| `DRY_RUN` | `false` | log the plan, change nothing |
| `RECONCILE_LOOKBACK_MINUTES` | `60` | timer window |
| `RECONCILE_MAX_PAGES` | `25` | page cap per run, a runaway guard. The catalogue is ~33 pages at the default `pageSize=200`, so raise it for a whole-catalogue pass; when the cap truncates a run it is logged, never silent |

## Suggested rollout

1. `node scripts/self-test.js`, then `--sku <one product> --dry-run`, then for real. Check the
   product in Shopify admin.
2. `--since <today> --limit 25` to watch a small batch behave.
3. `--all` for the catalogue backfill, `DELETE_REMOVED_MEDIA=false` throughout.
4. Deploy, register the webhook, confirm the timer in Application Insights.
5. Only then consider `DELETE_REMOVED_MEDIA=true`, once the `custom.unleashed_media` metafields
   are populated and trusted.

## Known limits

- **The 5-image cap is per Unleashed product code, not per Shopify product.** Where several
  Unleashed products share one Shopify product, the media count multiplies. Enforcing a true
  per-Shopify-product ceiling would need a rule for which codes win the slots.
- **Pre-existing images that no longer match are not cleaned up.** If an image was replaced in
  Unleashed after the old connector pushed it, the old file has a different filename, so it is
  neither adopted nor removed — it stays as unmanaged media. It must be deleted by hand in
  Shopify if unwanted.
- **Unmatched SKUs are reported, not fixed.** If no Shopify variant carries the Unleashed
  product code, the product is skipped with outcome `unmatched`. A code resolving to more than
  one Shopify product is skipped as `ambiguous`.
- Media stuck in Shopify's `FAILED` state is reported and left alone; delete it in Shopify to
  retry rather than having the sync loop on it.
- No cross-invocation deduplication of webhook events. It isn't needed — the sync is
  diff-based — but two deliveries for one product landing in the same second could both upload.
  The reconcile pass reports any duplicate that results.
- `modifiedSince` reflects **any** product change, not image changes specifically; Unleashed
  offers no image-level event. Products without images are skipped before Shopify is touched.
