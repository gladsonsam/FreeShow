import { get, writable } from "svelte/store"
import { Main } from "../../../types/IPC/Main"
import { MicCapture } from "../../audio/micCapture"
import { requestMain, sendMain } from "../../IPC/main"
import { ai } from "../../stores"

export const audioLevelStore = writable<number>(0.0)

export function resolveSttEngine(): string {
    return get(ai)?.stt?.engine || "nemotron"
}

type AudioLevelCallback = (level: number) => void

const CONSUMER_ID = "ai-stt"

export class SpeechToText {
    private static listeners = new Set<AudioLevelCallback>()

    private static sessionToken = 0

    static async enable() {
        const operationId = ++this.sessionToken

        const captured = await this.restartCapture(operationId)
        if (operationId !== this.sessionToken) {
            this.stopCapture()
            return { ok: false, aborted: true }
        }
        if (!captured.ok) return captured

        const started = await this.restartEngine(operationId)
        if (operationId !== this.sessionToken) {
            this.stopCapture()
            return { ok: false, aborted: true }
        }

        if (!started.ok) {
            this.stopCapture()
            return started
        }

        return { ok: true }
    }

    static async restartEngine(operationId?: number) {
        const token = operationId ?? ++this.sessionToken
        const engine = resolveSttEngine()
        const engineOptions = get(ai)?.stt?.engineOptions?.[engine] || {}

        const result = await requestMain(Main.AI_LISTEN_START, { engine, engineOptions }, undefined, 60000)

        if (token !== this.sessionToken) return { ok: false, aborted: true }
        if (!result?.started) return { ok: false, error: result?.error }

        return { ok: true }
    }

    static async restartCapture(operationId?: number) {
        const token = operationId ?? ++this.sessionToken
        this.stopCapture()

        const savedDeviceId = get(ai).stt?.micDeviceId || ""
        const deviceId = await MicCapture.resolveDeviceId(savedDeviceId)

        if (token !== this.sessionToken) return { ok: false, aborted: true }

        // Mute store update during initialization to avoid re-triggering component reactivity loop
        if (deviceId && deviceId !== savedDeviceId) {
            const currentAi = get(ai)
            if (currentAi?.stt) {
                currentAi.stt.micDeviceId = deviceId
            }
        }

        try {
            await MicCapture.acquire(CONSUMER_ID, deviceId, {
                onBlock: (block) => sendMain(Main.AI_AUDIO_DATA, { buffer: block.bytes }),
                onLevel: (level) => this.emitAudioLevel(level),
                onError: (err) => {
                    console.error("[AI STT]", err)
                    this.emitAudioLevel(0)
                }
            })
        } catch (err: any) {
            return { ok: false, error: err?.name === "NotAllowedError" || err?.name === "NotReadableError" ? "No microphone access" : "Could not create audio context" }
        }

        if (token !== this.sessionToken) {
            this.stopCapture()
            return { ok: false, aborted: true }
        }

        return { ok: true }
    }

    static disable() {
        this.sessionToken++
        sendMain(Main.AI_LISTEN_STOP)
        this.stopCapture()
    }

    static async resolveMicDeviceId(saved: string): Promise<string> {
        return MicCapture.resolveDeviceId(saved)
    }

    static onAudioLevel(callback: AudioLevelCallback): () => void {
        this.listeners.add(callback)
        return () => this.listeners.delete(callback)
    }

    private static emitAudioLevel(level: number) {
        const value = level < 0.04 ? 0 : level
        audioLevelStore.set(value)
        this.listeners.forEach((fn) => fn(value))
    }

    static stopCapture() {
        MicCapture.release(CONSUMER_ID)
        this.emitAudioLevel(0.0)
    }
}
