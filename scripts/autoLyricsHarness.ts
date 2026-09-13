// Auto Lyrics offline test harness.
//
//   npm run test:lyrics                        # every fixture, every variant
//   npm run test:lyrics -- --song Cornerstone  # one fixture
//   npm run test:lyrics -- --variant tempo_0.9,noise_10dB
//   npm run test:lyrics -- --sweep             # threshold x leadMs table
//   npm run test:lyrics -- --json out.json     # machine-readable results
//
// Fixtures live in fixtures/autolyrics/<song>/ as source.<ext> + cues.json.
// Export cues.json from the Auto Lyrics popup after one normal run-through of the song.

// must be first: FollowEngine persists maps through songMapStore (IndexedDB)
import "fake-indexeddb/auto"

import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadCueSheet, type CueSheet } from "../src/frontend/audio/lyrics/harness/cues"
import { decodePcm } from "../src/frontend/audio/lyrics/harness/decode"
import { formatScore, score, type Score } from "../src/frontend/audio/lyrics/harness/metrics"
import { applyVariant, VARIANTS, type Variant } from "../src/frontend/audio/lyrics/harness/perturb"
import { getMap, resetStore, runFollowPass, runLearningPass, type EngineOptions } from "../src/frontend/audio/lyrics/harness/runner"
import { AUTO_LYRICS_DEFAULTS } from "../src/frontend/audio/lyrics/types"

const FIXTURE_DIR = join(process.cwd(), "fixtures", "autolyrics")
const AUDIO_EXTENSIONS = [".wav", ".mp3", ".m4a", ".flac", ".ogg", ".opus", ".aac"]

interface Fixture {
    name: string
    audio: string
    sheet: CueSheet
}

interface Row {
    song: string
    variant: string
    threshold: number
    leadMs: number
    score: Score
}

function parseArgs() {
    const args = process.argv.slice(2)
    const get = (flag: string) => {
        const i = args.indexOf(flag)
        return i >= 0 ? args[i + 1] : undefined
    }
    return {
        song: get("--song"),
        variants: get("--variant")?.split(","),
        sweep: args.includes("--sweep"),
        json: get("--json"),
        threshold: Number(get("--threshold") ?? AUTO_LYRICS_DEFAULTS.threshold),
        leadMs: Number(get("--lead") ?? AUTO_LYRICS_DEFAULTS.leadMs)
    }
}

function loadFixtures(only?: string): Fixture[] {
    if (!existsSync(FIXTURE_DIR)) {
        console.error(`No fixtures directory at ${FIXTURE_DIR}`)
        console.error(`Create fixtures/autolyrics/<song>/ containing source.mp3 (or .wav) and cues.json.`)
        return []
    }

    const fixtures: Fixture[] = []
    for (const name of readdirSync(FIXTURE_DIR)) {
        if (only && name !== only) continue

        const dir = join(FIXTURE_DIR, name)
        const files = existsSync(dir) ? readdirSync(dir) : []
        const audio = files.find((f) => AUDIO_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)))
        const cueFile = join(dir, "cues.json")

        if (!audio || !existsSync(cueFile)) {
            console.warn(`skipping ${name}: needs an audio file and cues.json`)
            continue
        }

        fixtures.push({ name, audio: join(dir, audio), sheet: loadCueSheet(cueFile) })
    }
    return fixtures
}

// Learn once from the clean source, then follow each perturbed "performance".
async function runFixture(fixture: Fixture, variants: Variant[], opts: EngineOptions, rows: Row[], verbose: boolean) {
    const { cues, slideCount } = fixture.sheet

    await resetStore()
    const sourcePcm = await decodePcm(fixture.audio)
    const learn = await runLearningPass(sourcePcm, cues, slideCount, opts)

    if (!learn.learned) {
        console.log(`  ${fixture.name}: learning pass produced no usable map — check the cue sheet covers the song`)
        return
    }

    const map = await getMap()
    if (verbose) {
        console.log(`  learned ${((map?.frameCount || 0) / (map?.fps || 10)).toFixed(0)}s, ${map?.marks.length || 0} marks, ${slideCount} slides`)
    }

    for (const variant of variants) {
        const pcm = variant.filters ? await decodePcm(fixture.audio, variant.filters) : sourcePcm
        const expected = applyVariant(cues, variant)

        // the map persists between variants — each is another week's performance
        const result = await runFollowPass(pcm, slideCount, opts)
        const s = score(result, expected)

        rows.push({ song: fixture.name, variant: variant.name, threshold: opts.thresholdPct, leadMs: opts.leadMs, score: s })
        console.log(`  ${variant.name.padEnd(18)} ${formatScore(s)}`)
    }
}

async function main() {
    const args = parseArgs()
    const fixtures = loadFixtures(args.song)
    if (!fixtures.length) process.exit(1)

    const variants = args.variants ? VARIANTS.filter((v) => args.variants!.includes(v.name)) : VARIANTS
    if (!variants.length) {
        console.error(`Unknown variant. Available: ${VARIANTS.map((v) => v.name).join(", ")}`)
        process.exit(1)
    }

    const configs: EngineOptions[] = args.sweep ? [40, 55, 70, 85].flatMap((thresholdPct) => [0, 200, 400, 800].map((leadMs) => ({ thresholdPct, leadMs }))) : [{ thresholdPct: args.threshold, leadMs: args.leadMs }]

    const rows: Row[] = []

    for (const opts of configs) {
        if (configs.length > 1) console.log(`\n=== threshold ${opts.thresholdPct}%  lead ${opts.leadMs}ms ===`)

        for (const fixture of fixtures) {
            console.log(`\n${fixture.name} (${fixture.sheet.cues.length} cues, ${fixture.sheet.slideCount} slides)`)
            await runFixture(fixture, variants, opts, rows, configs.length === 1)
        }
    }

    // ---- summary ----
    if (rows.length > 1) {
        console.log(`\n${"=".repeat(70)}`)
        if (args.sweep) {
            console.log("mean coverage by config (higher is better, false advances in brackets):\n")
            const byConfig = new Map<string, Row[]>()
            for (const row of rows) {
                const key = `${row.threshold}% / ${row.leadMs}ms`
                byConfig.set(key, [...(byConfig.get(key) || []), row])
            }
            const ranked = [...byConfig.entries()]
                .map(([key, group]) => ({
                    key,
                    coverage: group.reduce((sum, r) => sum + r.score.coveragePct, 0) / group.length,
                    falseAdvances: group.reduce((sum, r) => sum + r.score.falseAdvances, 0)
                }))
                .sort((a, b) => b.coverage - a.coverage)

            for (const entry of ranked) console.log(`  ${entry.key.padEnd(16)} ${entry.coverage.toFixed(1)}%  [${entry.falseAdvances}]`)
            console.log(`\ncurrent defaults: ${AUTO_LYRICS_DEFAULTS.threshold}% / ${AUTO_LYRICS_DEFAULTS.leadMs}ms`)
        } else {
            const meanCoverage = rows.reduce((sum, r) => sum + r.score.coveragePct, 0) / rows.length
            const worst = [...rows].sort((a, b) => a.score.coveragePct - b.score.coveragePct).slice(0, 3)
            console.log(`mean coverage ${meanCoverage.toFixed(1)}% across ${rows.length} runs`)
            console.log(`weakest: ${worst.map((r) => `${r.song}/${r.variant} ${r.score.coveragePct}%`).join(", ")}`)
        }
    }

    if (args.json) {
        writeFileSync(args.json, JSON.stringify(rows, null, 2))
        console.log(`\nwrote ${args.json}`)
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
