#!/usr/bin/env bash
# Puts back the Notes the Shopify connector blanked on 26 Oct 2026 (17:40 AEDT)
# when the order-sync mapping metafield was written to 214 Shopify customers.
# The notes guard recorded the 27 as "cleared" (no web order involved) and kept
# the previous text in its snapshot; this restores that text. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."
export NOTES_STORAGE_CONNECTION="${NOTES_STORAGE_CONNECTION:-$(az storage account show-connection-string -g searay-func-rg -n searayunleashedsync -o tsv)}"
for code in AC058 BHJ001 BRC001 CFJ255 CJ198 DIS001 DJ327 GJ453 GM448 I014A I015A I032A I100A JOH564 LBJ652 M777 MLJ001 OJ834 PPJ876 S125 SAA002 SBJ021 SFF985 SJ1079 TFD001 TJ1177 YJ1252; do
  printf '%s: ' "$code"
  node scripts/customer-notes-cli.js --restore "$code" --apply 2>&1 | tail -1
done
