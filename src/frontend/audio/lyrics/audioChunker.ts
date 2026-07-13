// Captures microphone audio at 16 kHz mono and emits every raw capture block (~256 ms)
// to the follow engine's streaming feature extractor. The buffer is only valid during
// the callback (process synchronously, don't keep a reference).
//
// We request a dedicated 16kHz AudioContext so Chromium resamples the mic input for us.
// Noise suppression / AGC are disabled: they distort harmony and level, which the
// follow engine depends on.

import { Main } from "../../../types/IPC/Main"
import { sendMain } from "../../IPC/main"

const TARGET_RATE = 16000

export interface ChunkerCallbacks {
    onBlock: (pcm: Float32Array) => void
    onError: (err: Error) => void // async failure after a successful start (e.g. mic unplugged)
}

export class AudioChunker {
    private ctx: AudioContext | null = null
    private stream: MediaStream | null = null
    private source: MediaStreamAudioSourceNode | null = null
    private processor: ScriptProcessorNode | null = null
    private silentGain: GainNode | null = null

    constructor(private callbacks: ChunkerCallbacks) {}

    // Resolves when capturing, throws when the mic could not be opened.
    async start(micId: string) {
        try {
            const audioConstraints: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            if (micId) audioConstraints.deviceId = { exact: micId }
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
        } catch (err: any) {
            if (err?.name === "NotReadableError" || err?.name === "NotAllowedError") sendMain(Main.ACCESS_MICROPHONE_PERMISSION)
            throw err instanceof Error ? err : new Error(String(err))
        }

        // a USB interface getting unplugged mid-service ends the track silently
        this.stream.getAudioTracks().forEach((track) => {
            track.onended = () => this.callbacks.onError(new Error("Microphone disconnected"))
        })

        this.ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: "interactive" })
        this.source = this.ctx.createMediaStreamSource(this.stream)
        this.processor = this.ctx.createScriptProcessor(4096, 1, 1)
        this.silentGain = this.ctx.createGain()
        this.silentGain.gain.value = 0

        this.processor.onaudioprocess = (e) => this.callbacks.onBlock(e.inputBuffer.getChannelData(0))

        // ScriptProcessor only fires while connected to the graph; route through a muted gain so nothing is heard
        this.source.connect(this.processor)
        this.processor.connect(this.silentGain)
        this.silentGain.connect(this.ctx.destination)

        if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => null)
    }

    stop() {
        try {
            this.processor?.disconnect()
            this.silentGain?.disconnect()
            this.source?.disconnect()
            this.stream?.getTracks().forEach((t) => {
                t.onended = null
                t.stop()
            })
            if (this.ctx && this.ctx.state !== "closed") this.ctx.close()
        } catch (err) {
            console.error("AudioChunker stop error", err)
        }
        this.processor = null
        this.silentGain = null
        this.source = null
        this.stream = null
        this.ctx = null
    }
}
