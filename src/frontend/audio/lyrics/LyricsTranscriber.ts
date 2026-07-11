// Factory for the pluggable speech-to-text engine. The matcher/controller depend only on
// the LyricsTranscriber interface, so additional engines (cloud STT, native whisper.cpp,
// opportunistic Web Speech) can be added here without touching the rest of the feature.

import type { AutoLyricsEngine, LyricsTranscriber } from "./types"
import { WebSpeechTranscriber } from "./WebSpeechTranscriber"
import { WhisperTranscriber } from "./WhisperTranscriber"

export function createTranscriber(engine: AutoLyricsEngine): LyricsTranscriber {
    switch (engine) {
        case "web-speech":
            return new WebSpeechTranscriber()
        case "whisper-wasm":
        default:
            return new WhisperTranscriber()
    }
}

export type { LyricsTranscriber }
