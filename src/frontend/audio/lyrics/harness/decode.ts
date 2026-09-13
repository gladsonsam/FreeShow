// Decodes any audio file into what the follow engine gets live: mono f32 PCM at 16 kHz.

import { spawn } from "node:child_process"
import { CHROMA_FPS } from "../chromaFeatures"

export const SAMPLE_RATE = 16000
const BLOCK_SAMPLES = SAMPLE_RATE / CHROMA_FPS // one chroma hop, same as the mic worklet

function ffmpeg(args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] })

        const out: Buffer[] = []
        let err = ""
        proc.stdout.on("data", (chunk) => out.push(chunk))
        proc.stderr.on("data", (chunk) => (err += chunk))

        proc.on("error", () => reject(new Error("Could not run ffmpeg — is it installed?")))
        proc.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}:\n${err.split("\n").slice(-15).join("\n")}`))))
    })
}

// filters is an optional -af chain, used to synthesize a different "performance"
export async function decodePcm(file: string, filters = ""): Promise<Float32Array> {
    const args = ["-hide_banner", "-nostdin", "-i", file]
    if (filters) args.push("-af", filters)
    args.push("-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-")

    const raw = await ffmpeg(args)

    // the Buffer isn't guaranteed 4-byte aligned, so copy rather than view
    const pcm = new Float32Array(raw.byteLength / 4)
    for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readFloatLE(i * 4)
    return pcm
}

export function durationMs(pcm: Float32Array) {
    return (pcm.length / SAMPLE_RATE) * 1000
}

// a trailing partial block is dropped — the extractor only emits on full hops anyway
export function* blocks(pcm: Float32Array) {
    for (let i = 0; i < Math.floor(pcm.length / BLOCK_SAMPLES); i++) {
        yield { pcm: pcm.subarray(i * BLOCK_SAMPLES, (i + 1) * BLOCK_SAMPLES), timeMs: (i * BLOCK_SAMPLES * 1000) / SAMPLE_RATE }
    }
}
