// Captures microphone audio and emits overlapping mono 16kHz windows suitable for Whisper.
//
// We request a dedicated 16kHz AudioContext so Chromium resamples the mic input for us
// (Whisper expects 16kHz). A ScriptProcessor fills a ring buffer; every "hop" we emit the
// trailing "window" of samples, skipping windows below an energy gate (silence) so we never
// run inference on nothing.

import { Main } from "../../../types/IPC/Main"
import { sendMain } from "../../IPC/main"

const TARGET_RATE = 16000
const WINDOW_SEC = 4
const HOP_SEC = 1
const ENERGY_GATE = 0.0025 // RMS threshold below which a window is treated as silence

export interface ChunkerCallbacks {
    onWindow: (pcm: Float32Array, sampleRate: number) => void
    onError: (err: Error) => void
}

export class AudioChunker {
    private ctx: AudioContext | null = null
    private stream: MediaStream | null = null
    private source: MediaStreamAudioSourceNode | null = null
    private processor: ScriptProcessorNode | null = null
    private silentGain: GainNode | null = null

    private ring = new Float32Array(TARGET_RATE * WINDOW_SEC)
    private writePos = 0
    private filled = 0
    private samplesSinceEmit = 0

    private readonly windowSamples = TARGET_RATE * WINDOW_SEC
    private readonly hopSamples = TARGET_RATE * HOP_SEC

    constructor(private callbacks: ChunkerCallbacks) {}

    async start(micId: string) {
        try {
            const audioConstraints: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: true, autoGainControl: true }
            if (micId) audioConstraints.deviceId = { exact: micId }
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
        } catch (err: any) {
            if (err?.name === "NotReadableError" || err?.name === "NotAllowedError") sendMain(Main.ACCESS_MICROPHONE_PERMISSION)
            this.callbacks.onError(err instanceof Error ? err : new Error(String(err)))
            return
        }

        this.ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: "interactive" })
        // browser may ignore exact sampleRate on some platforms; we pass the real rate to the engine regardless
        this.source = this.ctx.createMediaStreamSource(this.stream)
        this.processor = this.ctx.createScriptProcessor(4096, 1, 1)
        this.silentGain = this.ctx.createGain()
        this.silentGain.gain.value = 0

        this.processor.onaudioprocess = (e) => this.handleAudio(e.inputBuffer.getChannelData(0))

        // ScriptProcessor only fires while connected to the graph; route through a muted gain so nothing is heard
        this.source.connect(this.processor)
        this.processor.connect(this.silentGain)
        this.silentGain.connect(this.ctx.destination)
    }

    private handleAudio(input: Float32Array) {
        // write into ring buffer
        for (let i = 0; i < input.length; i++) {
            this.ring[this.writePos] = input[i]
            this.writePos = (this.writePos + 1) % this.windowSamples
        }
        this.filled = Math.min(this.filled + input.length, this.windowSamples)
        this.samplesSinceEmit += input.length

        if (this.samplesSinceEmit < this.hopSamples || this.filled < this.windowSamples) return
        this.samplesSinceEmit = 0

        // read the contiguous window in chronological order starting at writePos (oldest sample)
        const window = new Float32Array(this.windowSamples)
        for (let i = 0; i < this.windowSamples; i++) {
            window[i] = this.ring[(this.writePos + i) % this.windowSamples]
        }

        if (this.rms(window) < ENERGY_GATE) return
        this.callbacks.onWindow(window, this.sampleRate())
    }

    private rms(buf: Float32Array) {
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        return Math.sqrt(sum / buf.length)
    }

    private sampleRate() {
        return this.ctx?.sampleRate || TARGET_RATE
    }

    stop() {
        try {
            this.processor?.disconnect()
            this.silentGain?.disconnect()
            this.source?.disconnect()
            this.stream?.getTracks().forEach((t) => t.stop())
            if (this.ctx && this.ctx.state !== "closed") this.ctx.close()
        } catch (err) {
            console.error("AudioChunker stop error", err)
        }
        this.processor = null
        this.silentGain = null
        this.source = null
        this.stream = null
        this.ctx = null
        this.writePos = 0
        this.filled = 0
        this.samplesSinceEmit = 0
    }
}
