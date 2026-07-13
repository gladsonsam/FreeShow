// Persistent "song map" — what the follower learns on the first pass through a song.
//
// A map is a chroma timeline of one full performance plus the moments the operator
// (or the follower itself) changed slides. Maps are keyed per show+layout and
// invalidated when the song's lyrics/slide structure changes.
//
// Stored in IndexedDB (typed arrays survive structured clone, so no JSON bloat):
// a 5-minute song is ~40 KB.

import { CHROMA_DIM, CHROMA_FPS } from "./chromaFeatures"

export interface SongMark {
    frame: number // chroma frame index when this slide went live
    slideIndex: number // layout slide index
}

export interface SongMap {
    key: string // `${showId}::${layoutId}`
    showId: string
    layoutId: string
    fps: number
    frameCount: number
    chroma: Uint8Array // quantized, CHROMA_DIM * frameCount
    energy: Uint8Array // quantized, frameCount
    marks: SongMark[]
    slideCount: number
    textHash: string // invalidate the map when lyrics change
    recordedAt: number
    manualPass: boolean // true = recorded while the operator navigated by hand
    passCount?: number // times this map has been recorded/refined
    locked?: boolean // operator locked the timing: never auto-replace
}

export function songMapKey(showId: string, layoutId: string) {
    return `${showId}::${layoutId}`
}

// ---------- quantization (pure helpers, unit-tested) ----------

// chroma components are 0..1 (unit vector of non-negative values)
export function quantizeVec(v: Float32Array): Uint8Array {
    const out = new Uint8Array(v.length)
    for (let i = 0; i < v.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(v[i] * 255)))
    return out
}

export function dequantizeChroma(q: Uint8Array): Float32Array {
    const out = new Float32Array(q.length)
    for (let i = 0; i < q.length; i++) out[i] = q[i] / 255
    return out
}

export function quantizeEnergy(e: number): number {
    return Math.max(0, Math.min(255, Math.round(e * 255)))
}

export function dequantizeEnergy(q: Uint8Array): Float32Array {
    const out = new Float32Array(q.length)
    for (let i = 0; i < q.length; i++) out[i] = q[i] / 255
    return out
}

// Cheap stable hash of the song's slide texts (order-sensitive)
export function hashSongText(slideTexts: string[]): string {
    let h = 5381
    const joined = slideTexts.join("\n")
    for (let i = 0; i < joined.length; i++) {
        h = ((h << 5) + h + joined.charCodeAt(i)) | 0
    }
    return `${slideTexts.length}:${(h >>> 0).toString(36)}`
}

export { CHROMA_DIM, CHROMA_FPS }

// ---------- IndexedDB persistence ----------

const DB_NAME = "freeshow-auto-lyrics"
const DB_VERSION = 1
const STORE = "songMaps"

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION)
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "key" })
            }
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error || new Error("IndexedDB open failed"))
        })
        dbPromise.catch(() => (dbPromise = null))
    }
    return dbPromise
}

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return openDb().then(
        (db) =>
            new Promise<T>((resolve, reject) => {
                const tx = db.transaction(STORE, mode)
                const req = run(tx.objectStore(STORE))
                req.onsuccess = () => resolve(req.result)
                req.onerror = () => reject(req.error || new Error("IndexedDB request failed"))
            })
    )
}

export const songMapStore = {
    get(key: string): Promise<SongMap | null> {
        return request<any>("readonly", (s) => s.get(key)).then((v) => v || null)
    },
    getAll(): Promise<SongMap[]> {
        return request<any[]>("readonly", (s) => s.getAll()).then((v) => v || [])
    },
    put(map: SongMap): Promise<void> {
        return request("readwrite", (s) => s.put(map)).then(() => undefined)
    },
    delete(key: string): Promise<void> {
        return request("readwrite", (s) => s.delete(key)).then(() => undefined)
    },
    async setLocked(key: string, locked: boolean): Promise<void> {
        const map = await this.get(key)
        if (map) await this.put({ ...map, locked })
    },
    count(): Promise<number> {
        return request<number>("readonly", (s) => s.count())
    },
    clearAll(): Promise<void> {
        return request("readwrite", (s) => s.clear()).then(() => undefined)
    }
}

// Which slides a stored map actually has timing for
export function mapCoveredSlides(marks: SongMark[]): number {
    return new Set(marks.map((m) => m.slideIndex)).size
}
