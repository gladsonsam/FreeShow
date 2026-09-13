// Decodes any audio file ffmpeg understands into the exact format the follow engine
// consumes live: mono 32-bit float PCM at 16 kHz.

import { spawn } from "node:child_process"
import { CHROMA_FPS } from "../chromaFeatures"

export const SAMPLE_RATE = 16000
// one chroma hop — the same block size the mic worklet delivers
export const BLOCK_SAMPLES = SAMPLE_RATE / CHROMA_FPS

export function runFfmpeg(args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] })

        const stdout: Buffer[] = []
        let stderr = ""

        proc.stdout.on("data", (chunk) => stdout.push(chunk))
        proc.stderr.on("data", (chunk) => (stderr += chunk.toString()))

        proc.on("error", (err) => reject(new Error(`Could not run ffmpeg (is it installed?): ${err.message}`)))
        proc.on("close", (code) => {
            if (code !== 0) return reject(new Error(`ffmpeg exited ${code}:\n${stderr.split("\n").slice(-15).join("\n")}`))
            resolve(Buffer.concat(stdout))
        })
    })
}

// `filters` is an optional ffmpeg -af chain used to synthesize a different "performance"
export async function decodePcm(file: string, filters = ""): Promise<Float32Array> {
    const args = ["-hide_banner", "-nostdin", "-i", file]
    if (filters) args.push("-af", filters)
    args.push("-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-")

    const raw = await runFfmpeg(args)

    // Buffer may not be 4-byte aligned for a Float32Array view, so copy into one
    const samples = new Float32Array(raw.byteLength / 4)
    for (let i = 0; i < samples.length; i++) samples[i] = raw.readFloatLE(i * 4)
    return samples
}

export function durationMs(pcm: Float32Array) {
    return (pcm.length / SAMPLE_RATE) * 1000
}

// Splits PCM into the ~100 ms blocks the engine is fed live. A trailing partial block
// is dropped: the extractor only emits on full hops anyway.
export function* blocks(pcm: Float32Array): Generator<{ pcm: Float32Array; timeMs: number }> {
    const count = Math.floor(pcm.length / BLOCK_SAMPLES)
    for (let i = 0; i < count; i++) {
        yield {
            pcm: pcm.subarray(i * BLOCK_SAMPLES, (i + 1) * BLOCK_SAMPLES),
            timeMs: (i * BLOCK_SAMPLES * 1000) / SAMPLE_RATE
        }
    }
}
