// Auto Lyrics Detection — shared types
//
// The feature listens to a microphone, transcribes sung lyrics with an on-device
// speech-to-text engine, and matches the transcript against slide text already in
// memory to help the operator stay on the right slide.

export type AutoLyricsEngine = "whisper-wasm" | "web-speech" | "fingerprint"
export type AutoLyricsMode = "suggest" | "auto"
export type AutoLyricsModel = "tiny" | "base"

// Persisted under "special.autoLyrics"
export interface AutoLyricsSettings {
    enabled: boolean
    mode: AutoLyricsMode
    detectSongSwitch: boolean
    micId: string
    engine: AutoLyricsEngine
    model: AutoLyricsModel
    language: string // "" = auto detect
    threshold: number // 0-100 confidence required to act
    stableWindows: number // consecutive windows a match must lead before acting
    cooldownMs: number // suppress new decisions for this long after any navigation
}

export const AUTO_LYRICS_DEFAULTS: AutoLyricsSettings = {
    enabled: false,
    mode: "suggest",
    detectSongSwitch: false,
    micId: "",
    engine: "whisper-wasm",
    model: "tiny",
    language: "",
    threshold: 55,
    stableWindows: 2,
    cooldownMs: 4000
}

export type AutoLyricsStatus = "off" | "loading-model" | "ready" | "listening" | "error"

export interface AutoLyricsSuggestion {
    type: "same-show-slide" | "different-song"
    showId: string
    slideIndex?: number
    label: string
    confidence: number
}

// Volatile runtime state (stores.ts "autoLyrics")
export interface AutoLyricsRuntime {
    status: AutoLyricsStatus
    errorMsg?: string
    lastTranscript: string
    suggestion: AutoLyricsSuggestion | null
    learnedCount?: number   // fingerprint engine: number of slides learned
    fpScore?: number        // fingerprint engine: last best match score (0-100), for debug display
}

// A transcription result emitted by an engine
export interface TranscriptChunk {
    text: string
    final: boolean
    ts: number
}

// Pluggable speech-to-text engine interface. The matcher/controller depend only on this,
// so the underlying engine (Whisper-WASM today, others later) can be swapped via a setting.
export interface LyricsTranscriber {
    /** True when the engine captures its own audio (e.g. Web Speech). The controller skips AudioChunker. */
    handlesOwnCapture?: boolean
    init(opts: { model?: AutoLyricsModel; language?: string }): Promise<void>
    start(): void
    stop(): void
    feed(pcm: Float32Array, sampleRate: number): void
    onTranscript(cb: (chunk: TranscriptChunk) => void): void
    onStatus(cb: (status: "loading" | "ready" | "running" | "stopped" | "error", detail?: string) => void): void
    onError(cb: (err: Error) => void): void
    dispose(): void
}
