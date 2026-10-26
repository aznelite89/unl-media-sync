import { BlobServiceClient } from '@azure/storage-blob';

import {
  ORDER_SYNC_CONTAINER,
  ORDER_SYNC_STATE_BLOB,
  ORDER_SYNC_STATE_VERSION,
} from '../constants/index.js';

const HTTP_NOT_FOUND = 404;
const JSON_CONTENT = { blobContentType: 'application/json' };

export function emptyOrderState() {
  return { version: ORDER_SYNC_STATE_VERSION, orders: {}, lastRunAt: null };
}

/** Anything malformed is treated as empty: Unleashed itself is the record of what exists. */
export function parseOrderState(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed.orders !== 'object' || parsed.orders === null) return emptyOrderState();
    return { ...emptyOrderState(), ...parsed };
  } catch {
    return emptyOrderState();
  }
}

/**
 * What this service has done with each Shopify order, in a private blob.
 *
 * It is a cache and a problem log, not the source of truth: before creating
 * anything the sync asks Unleashed whether `web#NNNN` already exists, so a
 * lost or stale state can never produce a duplicate order. Saves are
 * conditional on the ETag read, so the webhook and the timer cannot overwrite
 * each other; the loser simply retries on its next pass.
 *
 * @param {string} connectionString
 */
export function createBlobOrderStore(connectionString) {
  if (!connectionString || connectionString.includes('UseDevelopmentStorage')) {
    throw new Error(
      'No storage for the order sync state. Set ORDER_SYNC_STORAGE_CONNECTION to the ' +
        'searayunleashedsync connection string (az storage account show-connection-string ' +
        '-g searay-func-rg -n searayunleashedsync -o tsv).',
    );
  }
  const container = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(
    ORDER_SYNC_CONTAINER,
  );

  async function load() {
    const blob = container.getBlockBlobClient(ORDER_SYNC_STATE_BLOB);
    try {
      const { etag } = await blob.getProperties();
      const buffer = await blob.downloadToBuffer(0, undefined, { conditions: { ifMatch: etag } });
      return { state: parseOrderState(buffer.toString('utf8')), etag };
    } catch (error) {
      if (error?.statusCode === HTTP_NOT_FOUND) return { state: emptyOrderState(), etag: null };
      throw error;
    }
  }

  async function save(state, etag) {
    await container.createIfNotExists();
    const body = JSON.stringify(state);
    const conditions = etag ? { ifMatch: etag } : { ifNoneMatch: '*' };
    const result = await container
      .getBlockBlobClient(ORDER_SYNC_STATE_BLOB)
      .upload(body, Buffer.byteLength(body), { blobHTTPHeaders: JSON_CONTENT, conditions });
    return result.etag;
  }

  return { load, save };
}

/** Same contract, held in memory. For the CLI's dry runs and tests. */
export function createMemoryOrderStore(initial = null) {
  let stored = initial ? JSON.stringify(initial) : null;
  let version = stored ? 1 : 0;
  return {
    async load() {
      return stored
        ? { state: parseOrderState(stored), etag: String(version) }
        : { state: emptyOrderState(), etag: null };
    },
    async save(state, etag) {
      if ((etag ?? null) !== (stored ? String(version) : null)) throw new Error('state changed since it was read');
      stored = JSON.stringify(state);
      version += 1;
      return String(version);
    },
    peek() {
      return stored ? JSON.parse(stored) : null;
    },
  };
}
