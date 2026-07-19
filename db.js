const DB_NAME = "trailstack";
const DB_VERSION = 1;
const STORES = new Set(["entries", "audio"]);

let dbPromise;

function database() {
  if (!globalThis.idb?.openDB) {
    throw new Error("The IndexedDB helper did not load. Reload once while online.");
  }

  if (!dbPromise) {
    dbPromise = globalThis.idb.openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("entries")) {
          const entries = db.createObjectStore("entries", { keyPath: "client_id" });
          entries.createIndex("sync_state", "sync_state");
          entries.createIndex("ts", "ts");
          entries.createIndex("type", "type");
        }

        if (!db.objectStoreNames.contains("audio")) {
          const audio = db.createObjectStore("audio", { keyPath: "client_id" });
          audio.createIndex("sync_state", "sync_state");
        }
      },
    });
  }

  return dbPromise;
}

function assertStore(store) {
  if (!STORES.has(store)) {
    throw new Error(`Unknown IndexedDB store: ${store}`);
  }
}

export async function putEntry(entry) {
  const db = await database();
  await db.put("entries", entry);
  return entry;
}

export async function putAudio(audio) {
  // iOS Safari often rejects MediaRecorder Blobs (and sometimes the ArrayBuffers
  // derived from them) in IndexedDB with:
  // "Error preparing Blob/File data to be stored in object store".
  // Store a plain base64 string — structured-clone safe on WebKit.
  const buffer = await toArrayBuffer(audio.blob ?? audio.buffer ?? audio.bytes);
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(new Uint8Array(buffer));

  const db = await database();
  const record = {
    client_id: audio.client_id,
    data_b64: u8ToBase64(bytes),
    mime: audio.mime || "application/octet-stream",
    duration_s: audio.duration_s ?? null,
    sync_state: audio.sync_state || "pending",
  };
  await db.put("audio", record);
  return hydrateAudio(record);
}

export async function getEntry(clientId) {
  const db = await database();
  return db.get("entries", clientId);
}

export async function getAudio(clientId) {
  const db = await database();
  return hydrateAudio(await db.get("audio", clientId));
}

export async function getPending(store) {
  assertStore(store);
  const db = await database();
  const records = await db.getAllFromIndex(store, "sync_state", "pending");
  return store === "audio" ? records.map(hydrateAudio) : records;
}

export async function markSynced(store, clientId) {
  assertStore(store);
  const db = await database();
  const tx = db.transaction(store, "readwrite");
  const record = await tx.store.get(clientId);

  if (record) {
    record.sync_state = "synced";
    if (store === "entries") {
      record.synced_at = new Date().toISOString();
    }
    await tx.store.put(record);
  }

  await tx.done;
}

export async function patchEntry(clientId, changes) {
  const db = await database();
  const tx = db.transaction("entries", "readwrite");
  const entry = await tx.store.get(clientId);

  if (entry) {
    await tx.store.put({ ...entry, ...changes });
  }

  await tx.done;
}

export async function listEntries({ day, type } = {}) {
  const db = await database();
  const entries = await db.getAll("entries");

  return entries
    .filter((entry) => {
      const entryDay = localDay(entry.ts);
      return (!day || entryDay === day) && (!type || entry.type === type);
    })
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
}

export async function deleteEntry(clientId) {
  const db = await database();
  const tx = db.transaction(["entries", "audio"], "readwrite");
  await Promise.all([
    tx.objectStore("entries").delete(clientId),
    tx.objectStore("audio").delete(clientId),
  ]);
  await tx.done;
}

export async function deleteAudio(clientId) {
  const db = await database();
  await db.delete("audio", clientId);
}

function localDay(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function toArrayBuffer(source) {
  if (!source) throw new Error("Recording data was empty.");
  if (source instanceof ArrayBuffer) return source.slice(0);
  if (ArrayBuffer.isView(source)) {
    return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  }
  if (typeof Response !== "undefined" && typeof source.stream === "function") {
    try {
      return await new Response(source).arrayBuffer();
    } catch {
      // Fall through to Blob.arrayBuffer / FileReader.
    }
  }
  if (typeof source.arrayBuffer === "function") {
    return (await source.arrayBuffer()).slice(0);
  }
  if (typeof FileReader !== "undefined" && typeof Blob !== "undefined" && source instanceof Blob) {
    return readBlobAsArrayBuffer(source);
  }
  throw new Error("Unsupported recording data type.");
}

function readBlobAsArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read recording."));
    reader.readAsArrayBuffer(blob);
  });
}

function u8ToBase64(bytes) {
  const chunk = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToU8(dataB64) {
  const binary = atob(dataB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hydrateAudio(record) {
  if (!record) return null;
  const mime = record.mime || "application/octet-stream";
  let bytes;
  if (typeof record.data_b64 === "string") {
    bytes = base64ToU8(record.data_b64);
  } else if (record.bytes instanceof Uint8Array) {
    bytes = record.bytes;
  } else if (record.buffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(record.buffer);
  } else if (record.blob instanceof Blob) {
    // Legacy in-memory shape only; not re-persisted as a Blob.
    return {
      client_id: record.client_id,
      blob: record.blob,
      mime,
      duration_s: record.duration_s ?? null,
      sync_state: record.sync_state || "pending",
    };
  } else {
    throw new Error("Stored recording is missing audio bytes.");
  }

  return {
    client_id: record.client_id,
    blob: new Blob([bytes], { type: mime }),
    mime,
    duration_s: record.duration_s ?? null,
    sync_state: record.sync_state || "pending",
  };
}
