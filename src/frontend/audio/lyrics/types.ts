// Auto Lyrics — shared types
//
// Learn & Follow: learns a song's audio timeline the first time it is played (the
// operator navigates as usual), then tracks the live audio position on later plays
// and changes slides automatically. Fully offline and language-independent.

import type { FollowRuntime } from "./followEngine"

export type AutoLyricsMode = "suggest" | "auto"

// Persisted under "special.autoLyrics"
export interface AutoLyricsSettings {
    enabled: boolean
    mode: AutoLyricsMode
    micId: string
    threshold: number // 0-100 confidence required to act
    leadMs: number // change slides this many ms ahead of the learned timing
}

export const AUTO_LYRICS_DEFAULTS: AutoLyricsSettings = {
    enabled: false,
    mode: "suggest",
    micId: "",
    threshold: 55,
    leadMs: 400
}

export type AutoLyricsStatus = "off" | "loading-model" | "ready" | "listening" | "error"

export interface AutoLyricsSuggestion {
    showId: string
    slideIndex: number
    label: string
    confidence: number
}

// Volatile runtime state (stores.ts "autoLyrics")
export interface AutoLyricsRuntime {
    status: AutoLyricsStatus
    errorMsg?: string
    suggestion: AutoLyricsSuggestion | null
    follow?: FollowRuntime | null // follow engine live state
    savedSongs?: number // learned song maps in storage
}
