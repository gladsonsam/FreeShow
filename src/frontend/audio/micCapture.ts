// One mic capture shared by everything that analyses live audio (AI transcription, Auto
// Lyrics). They all want mono 16 kHz PCM with the browser's processing disabled, and
// opening the same device twice can fail outright on Windows.
//
// Buffers passed to onBlock are only valid during the call.

import { Main } from "../../types/IPC/Main"
import { sendMain } from "../IPC/main"

const RATE = 16000
// emits 1600 Int16 samples (100 ms) per message, which is also one Auto Lyrics chroma hop
const WORKLET = "./assets/stt-processor.js"

export interface MicBlock {
    bytes: Uint8Array // raw Int16, for sending to the main process
    pcm: Float32Array // same samples as -1..1 floats, for DSP here
}

export interface MicConsumer {
    onBlock?: (block: MicBlock) => void
    onError?: (err: Error) => void // died after starting, e.g. mic unplugged
    onLevel?: (level: number) => void // 0..1 RMS, per animation frame
}

interface Session {
    deviceId: string
    stream: MediaStream
    ctx: AudioContext
    analyser: AnalyserNode
    consumers: Map<string, MicConsumer>
}

export class MicCapture {
    private static sessions = new Map<string, Session>()
    private static attached = new Map<string, string>() // consumer id -> device
    private static starting = new Map<string, Promise<Session>>()

    // Throws if the mic could not be opened. Acquiring again with a different device moves over.
    static async acquire(id: string, requestedDevice: string, consumer: MicConsumer) {
        const deviceId = await this.resolveDeviceId(requestedDevice)
        if (this.attached.get(id) !== deviceId) this.release(id)

        const session = await this.getSession(deviceId)
        session.consumers.set(id, consumer)
        this.attached.set(id, deviceId)
    }

    static release(id: string) {
        const deviceId = this.attached.get(id)
        if (!deviceId) return
        this.attached.delete(id)

        const session = this.sessions.get(deviceId)
        if (!session) return

        session.consumers.delete(id)
        if (!session.consumers.size) this.stop(session)
    }

    private static getSession(deviceId: string) {
        const existing = this.sessions.get(deviceId)
        if (existing) return Promise.resolve(existing)

        // share one start between consumers acquiring the same device at once
        let starting = this.starting.get(deviceId)
        if (!starting) {
            starting = this.start(deviceId).finally(() => this.starting.delete(deviceId))
            this.starting.set(deviceId, starting)
        }
        return starting
    }

    private static async start(deviceId: string): Promise<Session> {
        const stream = await this.getMicStream(deviceId)
        const ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" })

        try {
            const source = ctx.createMediaStreamSource(stream)
            const analyser = ctx.createAnalyser()
            analyser.fftSize = 256
            source.connect(analyser)

            await ctx.audioWorklet.addModule(WORKLET)
            const worklet = new AudioWorkletNode(ctx, "stt-processor")

            const session: Session = { deviceId, stream, ctx, analyser, consumers: new Map() }
            worklet.port.onmessage = (e) => this.emit(session, e.data)

            source.connect(worklet)
            // produces no sound, but only runs while connected
            worklet.connect(ctx.destination)

            // a USB interface getting unplugged mid-service ends the track silently
            stream.getAudioTracks().forEach((track) => (track.onended = () => this.fail(session)))

            if (ctx.state === "suspended") await ctx.resume().catch(() => null)

            this.sessions.set(deviceId, session)
            this.monitorLevel(session)
            return session
        } catch (err) {
            stream.getTracks().forEach((track) => track.stop())
            ctx.close().catch(() => null)
            throw err
        }
    }

    private static stop(session: Session) {
        this.sessions.delete(session.deviceId)
        session.stream.getTracks().forEach((track) => {
            track.onended = null
            track.stop()
        })
        session.ctx.close().catch(() => null)
    }

    private static fail(session: Session) {
        const consumers = [...session.consumers.values()]
        session.consumers.forEach((_, id) => this.attached.delete(id))
        session.consumers.clear()
        this.stop(session)

        // each consumer decides on its own whether to retry
        consumers.forEach((consumer) => consumer.onError?.(new Error("Microphone disconnected")))
    }

    private static emit(session: Session, bytes: Uint8Array) {
        const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
        const pcm = new Float32Array(int16.length)
        for (let i = 0; i < int16.length; i++) pcm[i] = int16[i] / 0x8000

        session.consumers.forEach((consumer) => consumer.onBlock?.({ bytes, pcm }))
    }

    private static monitorLevel(session: Session) {
        const data = new Uint8Array(session.analyser.frequencyBinCount)

        const update = () => {
            if (!this.sessions.has(session.deviceId)) return
            session.analyser.getByteTimeDomainData(data)

            let sum = 0
            for (const byte of data) sum += ((byte - 128) / 128) ** 2

            const level = Math.min(1, Math.round(Math.sqrt(sum / data.length) * 4.5 * 100) / 100)
            session.consumers.forEach((consumer) => consumer.onLevel?.(level < 0.04 ? 0 : level))

            requestAnimationFrame(update)
        }

        update()
    }

    // The first enumerated input is often not the expected one (e.g. a Continuity iPhone),
    // so fall back to whatever device backs the "default" entry.
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

    // Noise suppression & AGC distort harmony and level, which both the transcriber and the
    // Auto Lyrics follow engine depend on.
    private static async getMicStream(deviceId: string, retries = 3): Promise<MediaStream> {
        const audio: MediaTrackConstraints = {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1
        }

        for (let attempt = 0; ; attempt++) {
            try {
                return await navigator.mediaDevices.getUserMedia({ audio })
            } catch (err: any) {
                if (err?.name === "NotReadableError" && attempt < retries - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 150))
                    continue
                }

                // the saved device is gone or can't honour the constraints
                if (err?.name === "OverconstrainedError" && deviceId) return this.getMicStream("", retries)

                if (err?.name === "NotReadableError" || err?.name === "NotAllowedError") sendMain(Main.ACCESS_MICROPHONE_PERMISSION)

                console.error("Error accessing microphone:", err)
                throw err
            }
        }
    }
}
