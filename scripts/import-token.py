#!/usr/bin/env python3
"""
Copies the existing Shopify Admin API token from one of the legacy C# sync
projects into local.settings.json, without printing it.

Those apps (Unleashed Sync / UnlShopSync / Searay API) all carry
write_products + read_products, which is what the image sync needs.

Run:  python3 ~/Desktop/Searay/unleashed-media-sync/scripts/import-token.py
"""
import json
import os
import re
import sys

HOME = os.path.expanduser("~")
SEARAY = os.path.join(HOME, "Desktop", "Searay")

SOURCES = [
    os.path.join(SEARAY, "unleashed to shopify updates", "UnlShopSkuSync", "appsettings.json"),
    os.path.join(
        SEARAY,
        "unleashed to shopify updates",
        "UnlShopProductLevelSync",
        "UnlShopProductLevelSync",
        "appsettings.json",
    ),
]
TARGET = os.path.join(SEARAY, "unleashed-media-sync", "local.settings.json")

token = None
source = None
for path in SOURCES:
    if not os.path.exists(path):
        continue
    match = re.search(r"shpat_[A-Za-z0-9]+", open(path, encoding="utf-8-sig").read())
    if match:
        token, source = match.group(0), path
        break

if not token:
    sys.exit("No shpat_ token found in:\n  " + "\n  ".join(SOURCES))

if not os.path.exists(TARGET):
    sys.exit(f"Missing {TARGET} — copy local.settings.json.example first.")

settings = json.load(open(TARGET, encoding="utf-8"))
settings.setdefault("Values", {})["SHOPIFY_ADMIN_TOKEN"] = token
with open(TARGET, "w", encoding="utf-8") as handle:
    json.dump(settings, handle, indent=2)
    handle.write("\n")

print(f"Token copied from: {os.path.relpath(source, SEARAY)}")
print(f"Written to local.settings.json as SHOPIFY_ADMIN_TOKEN ({len(token)} chars, value not shown).")
