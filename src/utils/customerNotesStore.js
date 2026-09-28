import { BlobServiceClient } from '@azure/storage-blob';

import {
  NOTES_HISTORY_PREFIX,
  NOTES_SNAPSHOT_BLOB,
  NOTES_SNAPSHOT_CONTAINER,
} from '../constants/index.js';
import { parseSnapshot } from './customerNotesPlan.js';

const HTTP_NOT_FOUND = 404;
const JSON_CONTENT = { blobContentType: 'application/json' };

/**
 * The customer notes snapshot in a private blob container.
 *
 * `load` returns `{ snapshot: null }` only when the blob does not exist; any
 * other failure throws. `save` is conditional on the ETag `load` returned, so
 * a CLI run and the timer cannot silently overwrite one another: the loser
 * throws and its next run starts from the winner's snapshot. Every save also
 * writes the day's copy under `history/`, which is the restore point.
 *
 * @param {string} connectionString
 */
export function createBlobNotesStore(connectionString) {
  if (!connectionString || connectionString.includes('UseDevelopmentStorage')) {
    throw new Error(
      'No storage for the customer notes snapshot. Set NOTES_STORAGE_CONNECTION to the ' +
        'searayunleashedsync connection string (az storage account show-connection-string ' +
        '-g searay-func-rg -n searayunleashedsync -o tsv).',
    );
  }
  const container = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(
    NOTES_SNAPSHOT_CONTAINER,
  );

  async function load() {
    const blob = container.getBlockBlobClient(NOTES_SNAPSHOT_BLOB);
    try {
      // Read the ETag first and download against it, so the text and the ETag
      // returned belong to the same version.
      const { etag } = await blob.getProperties();
      const buffer = await blob.downloadToBuffer(0, undefined, { conditions: { ifMatch: etag } });
      return { snapshot: parseSnapshot(buffer.toString('utf8')), etag };
    } catch (error) {
      if (error?.statusCode === HTTP_NOT_FOUND) return { snapshot: null, etag: null };
      throw error;
    }
  }

  async function save(snapshot, etag) {
    await container.createIfNotExists();
    const body = JSON.stringify(snapshot);
    const conditions = etag ? { ifMatch: etag } : { ifNoneMatch: '*' };
    const result = await container
      .getBlockBlobClient(NOTES_SNAPSHOT_BLOB)
      .upload(body, Buffer.byteLength(body), { blobHTTPHeaders: JSON_CONTENT, conditions });
    const day = new Date().toISOString().slice(0, 10);
    await container
      .getBlockBlobClient(`${NOTES_HISTORY_PREFIX}${day}.json`)
      .upload(body, Buffer.byteLength(body), { blobHTTPHeaders: JSON_CONTENT });
    return result.etag;
  }

  return { load, save };
}

/** Same contract, held in memory. For tests. */
export function createMemoryNotesStore(initial = null) {
  let stored = initial ? JSON.stringify(initial) : null;
  let version = stored ? 1 : 0;
  return {
    async load() {
      return stored ? { snapshot: parseSnapshot(stored), etag: String(version) } : { snapshot: null, etag: null };
    },
    async save(snapshot, etag) {
      if ((etag ?? null) !== (stored ? String(version) : null)) throw new Error('snapshot changed since it was read');
      stored = JSON.stringify(snapshot);
      version += 1;
      return String(version);
    },
    peek() {
      return stored ? JSON.parse(stored) : null;
    },
  };
}
