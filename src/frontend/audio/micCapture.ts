// Shared microphone capture for the features that analyse live audio (AI speech-to-text,
// Auto Lyrics). They all need the exact same thing — mono PCM at 16 kHz with the browser's
// "helpful" processing disabled — so they share one stream, one AudioContext and one
// AudioWorklet per device instead of each opening their own.
//
// This matters beyond tidiness: opening the same input device twice can fail outright
// (NotReadableError on exclusive-mode Windows drivers) and doubles the capture cost.
//
// Consumers acquire by id and get every ~100 ms block; the session is torn down when the
// last consumer releases it. Buffers handed to onBlock are only valid during the callback —
// process synchronously or copy.

import { Main } from "../../types/IPC/Main"
import { sendMain } from "../IPC/main"

const TARGET_RATE = 16000
// public/assets/stt-processor.js — emits 1600 Int16 samples (100 ms at 16 kHz) per message,
// which is also exactly one chroma hop for Auto Lyrics
const WORKLET_URL = "./assets/stt-processor.js"
const WORKLET_NAME = "stt-processor"

export interface MicBlock {
    bytes: Uint8Array // raw Int16 little-endian, for passing to the main process
    pcm: Float32Array // same samples as -1..1 floats, for in-renderer DSP
}

export interface MicConsumer {
    onBlock?: (block: MicBlock) => void
    onError?: (err: Error) => void // async failure after a successful start (e.g. mic unplugged)
    onLevel?: (level: number) => void // 0..1 RMS, once per animation frame
}

interface MicSession {
    deviceId: string
    stream: MediaStream
    ctx: AudioContext
    source: MediaStreamAudioSourceNode
    worklet: AudioWorkletNode
    analyser: AnalyserNode
    animFrameId: number | null
    consumers: Map<string, MicConsumer>
}

export class MicCapture {
    // one session per resolved device — STT and Auto Lyrics may be pointed at different inputs
    private static sessions = new Map<string, MicSession>()
    // consumer id -> the device it is attached to
    private static attached = new Map<string, string>()
    // in-flight starts, so two consumers acquiring the same device at once share one session
    private static starting = new Map<string, Promise<MicSession>>()

    // Resolves once capturing, throws if the mic could not be opened.
    // Re-acquiring with a different device moves the consumer over.
    static async acquire(id: string, requestedDeviceId: string, consumer: MicConsumer): Promise<void> {
        const deviceId = await this.resolveDeviceId(requestedDeviceId)

        const current = this.attached.get(id)
        if (current && current !== deviceId) this.release(id)

        let session: MicSession
        try {
            session = await this.getSession(deviceId)
        } catch (err) {
            throw err instanceof Error ? err : new Error(String(err))
        }

        session.consumers.set(id, consumer)
        this.attached.set(id, deviceId)
    }

    static release(id: string) {
        const deviceId = this.attached.get(id)
        if (deviceId === undefined) return
        this.attached.delete(id)

        const session = this.sessions.get(deviceId)
        if (!session) return

        session.consumers.delete(id)
        if (!session.consumers.size) this.stopSession(session)
    }

    static isActive(id: string) {
        return this.attached.has(id)
    }

    // ---------- session lifecycle ----------

    private static async getSession(deviceId: string): Promise<MicSession> {
        const existing = this.sessions.get(deviceId)
        if (existing) return existing

        const pending = this.starting.get(deviceId)
        if (pending) return pending

        const start = this.startSession(deviceId).finally(() => this.starting.delete(deviceId))
        this.starting.set(deviceId, start)
        return start
    }

    private static async startSession(deviceId: string): Promise<MicSession> {
        const stream = await this.getMicStream(deviceId)

        let ctx: AudioContext | null = null
        try {
            ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: "interactive" })
            const source = ctx.createMediaStreamSource(stream)

            const analyser = ctx.createAnalyser()
            analyser.fftSize = 256
            source.connect(analyser)

            await ctx.audioWorklet.addModule(WORKLET_URL)
            const worklet = new AudioWorkletNode(ctx, WORKLET_NAME)

            const session: MicSession = { deviceId, stream, ctx, source, worklet, analyser, animFrameId: null, consumers: new Map() }

            worklet.port.onmessage = (e) => this.emitBlock(session, e.data)
            source.connect(worklet)
            // the worklet produces no output, but only runs while connected to the graph
            worklet.connect(ctx.destination)

            // a USB interface getting unplugged mid-service ends the track silently
            stream.getAudioTracks().forEach((track) => {
                track.onended = () => this.failSession(session, new Error("Microphone disconnected"))
            })

            if (ctx.state === "suspended") await ctx.resume().catch(() => null)

            this.sessions.set(deviceId, session)
            this.startLevelMonitoring(session)

            return session
        } catch (err) {
            stream.getTracks().forEach((track) => track.stop())
            if (ctx && ctx.state !== "closed") ctx.close().catch(() => null)
            throw err instanceof Error ? err : new Error(String(err))
        }
    }

    private static stopSession(session: MicSession) {
        this.sessions.delete(session.deviceId)

        if (session.animFrameId !== null) {
            cancelAnimationFrame(session.animFrameId)
            session.animFrameId = null
        }

        try {
            session.worklet.port.onmessage = null
            ;[session.source, session.worklet, session.analyser].forEach((node) => {
                try {
                    node.disconnect()
                } catch (_) {
                    // already disconnected
                }
            })

            session.stream.getTracks().forEach((track) => {
                track.onended = null
                track.enabled = false
                track.stop()
            })

            if (session.ctx.state !== "closed") session.ctx.close().catch(() => null)
        } catch (err) {
            console.error("MicCapture stop error", err)
        }

        session.consumers.forEach((consumer) => consumer.onLevel?.(0))
    }

    // The device died. Tear the session down and tell every consumer — each decides
    // on its own whether to retry.
    private static failSession(session: MicSession, err: Error) {
        const consumers = [...session.consumers.entries()]
        consumers.forEach(([id]) => this.attached.delete(id))
        session.consumers.clear()

        this.stopSession(session)
        consumers.forEach(([, consumer]) => consumer.onError?.(err))
    }

    private static emitBlock(session: MicSession, bytes: Uint8Array) {
        if (!session.consumers.size) return

        const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
        const pcm = new Float32Array(int16.length)
        for (let i = 0; i < int16.length; i++) pcm[i] = int16[i] / 0x8000

        const block: MicBlock = { bytes, pcm }
        session.consumers.forEach((consumer) => {
            try {
                consumer.onBlock?.(block)
            } catch (err) {
                console.error("MicCapture consumer error", err)
            }
        })
    }

    private static startLevelMonitoring(session: MicSession) {
        const data = new Uint8Array(session.analyser.frequencyBinCount)

        const update = () => {
            if (!this.sessions.has(session.deviceId) || session.ctx.state === "closed") return

            session.analyser.getByteTimeDomainData(data)
            let sum = 0
            for (const byte of data) {
                const sample = (byte - 128) / 128
                sum += sample * sample
            }

            const rms = Math.sqrt(sum / data.length)
            const level = Math.min(1, Math.round(rms * 4.5 * 100) / 100)
            session.consumers.forEach((consumer) => consumer.onLevel?.(level < 0.04 ? 0 : level))

            session.animFrameId = requestAnimationFrame(update)
        }

        update()
    }

    // ---------- device helpers ----------

    // The first enumerated input is often not the one the user expects (e.g. a Continuity
    // iPhone), so fall back to the device backing the "default" entry.
    static async resolveDeviceId(saved: string): Promise<string> {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices()
            const inputs = devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "default")

            if (!inputs.length) return saved
            if (saved && inputs.some((d) => d.deviceId === saved)) return saved

            const virtualDefault = devices.find((d) => d.deviceId === "default")
            const systemDefault = virtualDefault?.groupId ? inputs.find((d) => d.groupId === virtualDefault.groupId) : undefined

            return systemDefault?.deviceId || inputs[0].deviceId
        } catch (err) {
            console.error("Could not enumerate microphones:", err)
            return saved
        }
    }

    // Noise suppression / AGC are disabled: they distort harmony and level, which both the
    // transcriber and the Auto Lyrics follow engine depend on.
    static async getMicStream(deviceId = "", retries = 3, delayMs = 150): Promise<MediaStream> {
        const audioConstraints: MediaTrackConstraints = {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1
        }

        let lastError: any = null

        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
            } catch (err: any) {
                lastError = err

                if (err?.name === "NotReadableError" && attempt < retries - 1) {
                    console.warn(`[MicCapture] Mic hardware busy, retrying (${attempt + 1}/${retries})...`)
                    await new Promise((resolve) => setTimeout(resolve, delayMs))
                    continue
                }

                if (err?.name === "NotReadableError" || err?.name === "NotAllowedError") {
                    sendMain(Main.ACCESS_MICROPHONE_PERMISSION)
                    break
                }

                // the saved device is gone or cannot honour the constraints
                if (err?.name === "OverconstrainedError" && deviceId) {
                    return this.getMicStream("", retries, delayMs)
                }

                break
            }
        }

        console.error("Error accessing microphone:", lastError)
        throw lastError instanceof Error ? lastError : new Error("No microphone access")
    }
}
