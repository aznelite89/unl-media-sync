#!/usr/bin/env bash
#
# Creates (if needed) and deploys the Function App.
#
# Prerequisites:  az login   — run it yourself, it opens a browser.
#
# Safe to re-run: resource creation is skipped when the resource already exists,
# so this doubles as the redeploy path.
#
#   ./scripts/deploy.sh
#
set -euo pipefail

RG=${RG:-searay-func-rg}
APP=${APP:-searay-unleashed-sync}
STORAGE=${STORAGE:-searayunleashedsync}
LOCATION=${LOCATION:-australiaeast}
NODE_VERSION=${NODE_VERSION:-22}

cd "$(dirname "$0")/.."

# npm's global bin is not always on PATH in non-interactive shells, so resolve
# the Core Tools binary rather than assuming `func` is callable by name.
FUNC=${FUNC:-$(command -v func || true)}
if [ -z "$FUNC" ]; then
  FUNC="$(npm prefix -g)/bin/func"
fi
if [ ! -x "$FUNC" ]; then
  echo "Azure Functions Core Tools not found. Install with:" >&2
  echo "  npm install -g azure-functions-core-tools@4" >&2
  exit 1
fi

echo "==> Subscription"
az account show --query "{name:name, id:id}" -o tsv

echo "==> Storage account: $STORAGE"
if az storage account show -g "$RG" -n "$STORAGE" -o none 2>/dev/null; then
  echo "    exists, skipping"
else
  az storage account create \
    --name "$STORAGE" \
    --resource-group "$RG" \
    --location "$LOCATION" \
    --sku Standard_LRS \
    --allow-blob-public-access false \
    --output none
  echo "    created"
fi

echo "==> Function App: $APP"
if az functionapp show -g "$RG" -n "$APP" -o none 2>/dev/null; then
  echo "    exists, skipping"
else
  az functionapp create \
    --name "$APP" \
    --resource-group "$RG" \
    --storage-account "$STORAGE" \
    --consumption-plan-location "$LOCATION" \
    --os-type Linux \
    --runtime node \
    --runtime-version "$NODE_VERSION" \
    --functions-version 4 \
    --output none
  echo "    created"
fi

echo "==> Application settings (values are never printed)"
python3 scripts/push-settings.py "$RG" "$APP"

echo "==> Publishing code"
"$FUNC" azure functionapp publish "$APP"

echo
echo "==> Deployed. Webhook endpoint:"
echo "    https://$APP.azurewebsites.net/api/unleashed/product-webhook"
echo
echo "Next: register the Unleashed subscription and store the returned signatureKey"
echo "  node scripts/register-webhook.js https://$APP.azurewebsites.net/api/unleashed/product-webhook"
echo "  az functionapp config appsettings set -g $RG -n $APP --settings UNLEASHED_WEBHOOK_SIGNATURE_KEY=<key>"
