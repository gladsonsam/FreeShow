// Feeds the follow engine's streaming feature extractor with mono 16 kHz PCM blocks
// (~100 ms each). The buffer is only valid during the callback (process synchronously,
// don't keep a reference).
//
// The capture itself is shared with the other live-audio features via MicCapture, so
// enabling Auto Lyrics alongside AI transcription does not open the device twice.

import { MicCapture } from "../micCapture"

const CONSUMER_ID = "auto-lyrics"

export interface ChunkerCallbacks {
    onBlock: (pcm: Float32Array) => void
    onError: (err: Error) => void // async failure after a successful start (e.g. mic unplugged)
}

export class AudioChunker {
    constructor(private callbacks: ChunkerCallbacks) {}

    // Resolves when capturing, throws when the mic could not be opened.
    async start(micId: string) {
        await MicCapture.acquire(CONSUMER_ID, micId, {
            onBlock: (block) => this.callbacks.onBlock(block.pcm),
            onError: (err) => this.callbacks.onError(err)
        })
    }

    stop() {
        MicCapture.release(CONSUMER_ID)
    }
}
