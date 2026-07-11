// Whisper speech-to-text engine (transformers.js, on-device).
//
// Build/runtime constraints shaped this design:
//   - The production renderer is a single IIFE bundle, which cannot bundle a `new Worker(new
//     URL(...))` worker file (no import.meta.url in IIFE).
//   - ONNX Runtime's own proxy / multi-thread workers are unreliable under Electron's CSP.
//
// So we create our OWN module worker from a Blob (allowed by `worker-src blob:` in the CSP) and
// run the entire transformers.js pipeline inside it, single-threaded. This keeps the renderer's
// main thread free during a live service, while letting us catch worker errors directly. The
// large ML library is loaded from a CDN inside the worker, so it never bloats the app bundle.
// Model weights download once and are then cached by the browser (offline thereafter).

import type { AutoLyricsModel, LyricsTranscriber, TranscriptChunk } from "./types"

const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2"

// Whisper emits these tokens when it hears non-speech audio (music, silence, noise).
// Square-bracket tokens are always Whisper metadata; the parenthetical list covers its
// known hallucination phrases so they aren't matched against slide lyrics.
const NON_SPEECH_RE =
    /\[[^\]]*\]|\(\s*(?:music|applause|laughter|laughing|silence|noise|background\s*music|instrumental|crowd|clapping|cheering|humming|whistling|no\s*speech)[^)]*\)|[♪♫]+/gi

function stripNonSpeech(text: string): string {
    return text.replace(NON_SPEECH_RE, "").trim()
}

// Whisper hallucinates short music-description phrases ("upbeat music", "the music plays",
// "beautiful background music") when it hears instruments but can't make out lyrics.
// Any transcript ≤4 words that contains the word "music" is almost certainly one of these.
// Real lyrics mentioning "music" (e.g. "make music to the Lord") are longer and pass through.
function isMusicHallucination(text: string): boolean {
    if (!/\bmusic\b/i.test(text)) return false
    return text.split(/\s+/).filter((w) => w.length >= 2).length <= 4
}

const MODEL_IDS: Record<AutoLyricsModel, string> = {
    tiny: "Xenova/whisper-tiny",
    base: "Xenova/whisper-base"
}

// Worker source. Runs the pipeline single-threaded inside the worker (no nested ORT workers),
// which is reliable under the CSP and keeps the main thread responsive.
function workerSource(cdn: string) {
    return `
        let asr = null
        self.onmessage = async (e) => {
            const msg = e.data
            if (msg.type === "init") {
                try {
                    const { pipeline, env } = await import(${JSON.stringify(cdn)} + "/dist/transformers.min.js")
                    env.allowLocalModels = false
                    env.backends.onnx.wasm.proxy = false
                    env.backends.onnx.wasm.numThreads = 1
                    asr = await pipeline("automatic-speech-recognition", msg.model, { device: "wasm", dtype: "q8" })
                    self.postMessage({ type: "ready" })
                } catch (err) {
                    self.postMessage({ type: "error", message: String((err && err.message) || err) })
                }
                return
            }
            if (msg.type === "audio" && asr) {
                try {
                    const options = { task: "transcribe", chunk_length_s: 0 }
                    if (msg.language) options.language = msg.language
                    const result = await asr(msg.pcm, options)
                    const text = (Array.isArray(result) ? (result[0] && result[0].text) : (result && result.text)) || ""
                    self.postMessage({ type: "transcript", text: text })
                } catch (err) {
                    self.postMessage({ type: "error", message: String((err && err.message) || err) })
                }
            }
        }
    `
}

type StatusCb = (status: "loading" | "ready" | "running" | "stopped" | "error", detail?: string) => void

export class WhisperTranscriber implements LyricsTranscriber {
    private worker: Worker | null = null
    private workerUrl = ""
    private model: AutoLyricsModel = "tiny"
    private language = ""
    private ready = false
    private running = false
    private busy = false
    private latest: Float32Array | null = null

    private transcriptCb: ((chunk: TranscriptChunk) => void) | null = null
    private statusCb: StatusCb | null = null
    private errorCb: ((err: Error) => void) | null = null

    onTranscript(cb: (chunk: TranscriptChunk) => void) {
        this.transcriptCb = cb
    }
    onStatus(cb: StatusCb) {
        this.statusCb = cb
    }
    onError(cb: (err: Error) => void) {
        this.errorCb = cb
    }

    init(opts: { model?: AutoLyricsModel; language?: string }) {
        this.model = opts.model || "tiny"
        this.language = opts.language || ""
        this.statusCb?.("loading")

        return new Promise<void>((resolve, reject) => {
            try {
                const blob = new Blob([workerSource(TRANSFORMERS_CDN)], { type: "application/javascript" })
                this.workerUrl = URL.createObjectURL(blob)
                this.worker = new Worker(this.workerUrl, { type: "module" })
            } catch (err) {
                const e = err instanceof Error ? err : new Error(String(err))
                this.statusCb?.("error", e.message)
                reject(e)
                return
            }

            this.worker.onmessage = (e: MessageEvent) => {
                const msg = e.data
                if (msg.type === "ready") {
                    this.ready = true
                    this.statusCb?.("ready")
                    resolve()
                } else if (msg.type === "transcript") {
                    const text = stripNonSpeech((msg.text || "").trim())
                    if (text && !isMusicHallucination(text) && this.transcriptCb) this.transcriptCb({ text, final: true, ts: performance.now() })
                    this.busy = false
                    this.pump()
                } else if (msg.type === "error") {
                    this.busy = false
                    const err = new Error(msg.message || "engine error")
                    if (!this.ready) {
                        this.statusCb?.("error", err.message)
                        reject(err)
                    } else {
                        this.errorCb?.(err)
                    }
                }
            }
            this.worker.onerror = (e) => {
                const err = new Error(e.message || "worker error")
                if (!this.ready) {
                    this.statusCb?.("error", err.message)
                    reject(err)
                } else this.errorCb?.(err)
            }

            this.worker.postMessage({ type: "init", model: MODEL_IDS[this.model], language: this.language })
        })
    }

    start() {
        this.running = true
        this.statusCb?.("running")
    }

    stop() {
        this.running = false
        this.latest = null
        this.statusCb?.("stopped")
    }

    // Newest window wins: while inference runs we keep only the latest window so we never build a backlog.
    feed(pcm: Float32Array) {
        if (!this.running || !this.ready) return
        this.latest = pcm
        this.pump()
    }

    private pump() {
        if (this.busy || !this.latest || !this.worker || !this.running) return
        const pcm = this.latest
        this.latest = null
        this.busy = true
        // transfer the buffer (zero-copy); the chunker allocates a fresh buffer per window
        this.worker.postMessage({ type: "audio", pcm, language: this.language }, [pcm.buffer])
    }

    dispose() {
        this.running = false
        this.ready = false
        this.latest = null
        this.worker?.terminate()
        this.worker = null
        if (this.workerUrl) URL.revokeObjectURL(this.workerUrl)
        this.workerUrl = ""
        this.transcriptCb = null
        this.statusCb = null
        this.errorCb = null
    }
}
