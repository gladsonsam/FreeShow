// Auto Lyrics offline test harness.
//
//   npm run test:lyrics                        # every fixture, every variant
//   npm run test:lyrics -- --song Cornerstone  # one fixture
//   npm run test:lyrics -- --variant tempo_0.9x,noise_10dB
//   npm run test:lyrics -- --sweep             # threshold x leadMs table
//   npm run test:lyrics -- --json out.json     # machine-readable results
//   npm run test:lyrics -- --audio take.wav --cues cues.json
//
// Fixtures live in fixtures/autolyrics/<song>/ as source.<ext> + cues.json.
// Export cues.json from the Auto Lyrics popup after one normal run-through of the song.

// must be first: FollowEngine persists maps through songMapStore (IndexedDB)
import "fake-indexeddb/auto"

import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { expectedSlideAt, loadCueSheet, type CueSheet } from "../src/frontend/audio/lyrics/harness/cues"
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
    keyShift: number
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
        audio: get("--audio"),
        cues: get("--cues"),
        variants: get("--variant")?.split(","),
        sweep: args.includes("--sweep"),
        help: args.includes("--help") || args.includes("-h"),
        list: args.includes("--list"),
        trace: args.includes("--trace"),
        json: get("--json"),
        dumpMap: get("--dump-map"),
        threshold: Number(get("--threshold") ?? AUTO_LYRICS_DEFAULTS.threshold),
        leadMs: Number(get("--lead") ?? AUTO_LYRICS_DEFAULTS.leadMs),
        minCoverage: get("--min-coverage") === undefined ? undefined : Number(get("--min-coverage")),
        maxFalse: get("--max-false") === undefined ? undefined : Number(get("--max-false"))
    }
}

function printHelp() {
    console.log(`Auto Lyrics offline regression harness

Usage:
  npm run test:lyrics
  npm run test:lyrics -- --song <fixture-name>
  npm run test:lyrics -- --audio <recording> --cues <cues.json>

Options:
  --variant <names>       Comma-separated audio variants (use --list to see them)
  --threshold <percent>   Follow confidence threshold
  --lead <milliseconds>   Advance lyrics this far before the learned cue
  --sweep                 Compare common threshold and lead combinations
  --json <path>           Write machine-readable results
  --dump-map <path>       Export the learned map, including exact base64 feature data
  --min-coverage <pct>    Fail if any run has lower timeline coverage
  --max-false <count>     Fail if any run has more false advances
  --trace                 Print every follow decision beside the expected slide
  --list                  List fixture and variant names
  --help                  Show this help

The direct --audio/--cues form does not require launching FreeShow. See
scripts/autoLyricsHarness.md for the cue-sheet format.`)
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

function loadDirectFixture(audio: string, cues: string): Fixture[] {
    const audioPath = resolve(audio)
    const cuesPath = resolve(cues)
    if (!existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`)
    if (!existsSync(cuesPath)) throw new Error(`Cue sheet not found: ${cuesPath}`)
    return [{ name: basename(audioPath), audio: audioPath, sheet: loadCueSheet(cuesPath) }]
}

// Learn once from the clean source, then follow each perturbed "performance".
async function runFixture(fixture: Fixture, variants: Variant[], opts: EngineOptions, rows: Row[], verbose: boolean, trace: boolean, dumpMap?: string) {
    const { cues, slideCount } = fixture.sheet

    await resetStore()
    const sourcePcm = await decodePcm(fixture.audio)
    const learn = await runLearningPass(sourcePcm, cues, slideCount, opts, fixture.sheet)

    if (!learn.learned) {
        throw new Error(`${fixture.name}: learning pass produced no usable map — check the cue sheet covers the song`)
    }

    const map = verbose || dumpMap ? await getMap(fixture.sheet) : null
    if (verbose) {
        console.log(`  learned ${((map?.frameCount || 0) / (map?.fps || 10)).toFixed(0)}s, ${map?.marks.length || 0} marks, ${slideCount} slides`)
    }
    if (dumpMap && map) {
        const exported = {
            ...map,
            durationMs: Math.round((map.frameCount / map.fps) * 1000),
            storageBytes: map.chroma.byteLength + map.energy.byteLength,
            marks: map.marks.map((mark) => ({ ...mark, timeMs: Math.round((mark.frame / map.fps) * 1000) })),
            chroma: Buffer.from(map.chroma).toString("base64"),
            energy: Buffer.from(map.energy).toString("base64")
        }
        writeFileSync(resolve(dumpMap), JSON.stringify(exported, null, 2))
        console.log(`  wrote learned map ${resolve(dumpMap)}`)
    }

    for (const variant of variants) {
        const pcm = variant.filters ? await decodePcm(fixture.audio, variant.filters) : sourcePcm
        const expected = applyVariant(cues, variant)

        // the map persists between variants — each one is another week's performance
        const result = await runFollowPass(pcm, slideCount, opts, fixture.sheet)
        const s = score(result, expected)

        rows.push({ song: fixture.name, variant: variant.name, threshold: opts.thresholdPct, leadMs: opts.leadMs, keyShift: result.keyShift, score: s })
        console.log(`  ${variant.name.padEnd(18)} key ${result.keyShift >= 0 ? "+" : ""}${result.keyShift}  ${formatScore(s)}`)
        if (trace) {
            for (const decision of result.decisions) {
                const expectedSlide = expectedSlideAt(expected, decision.timeMs)
                console.log(`    ${(decision.timeMs / 1000).toFixed(1).padStart(6)}s -> ${String(decision.slideIndex + 1).padStart(2)}  expected ${String(expectedSlide + 1).padStart(2)}  conf ${decision.confidence}%`)
            }
        }
    }
}

async function main() {
    const args = parseArgs()
    if (args.help) {
        printHelp()
        return
    }

    if (!!args.audio !== !!args.cues) throw new Error("--audio and --cues must be supplied together")
    if (![args.threshold, args.leadMs, args.minCoverage ?? 0, args.maxFalse ?? 0].every(Number.isFinite)) throw new Error("Threshold, lead, and pass/fail gates must be numbers")

    if (args.list) {
        const fixtures = existsSync(FIXTURE_DIR) ? readdirSync(FIXTURE_DIR) : []
        console.log(`fixtures: ${fixtures.length ? fixtures.join(", ") : "(none)"}`)
        console.log(`variants: ${VARIANTS.map((variant) => variant.name).join(", ")}`)
        return
    }

    const fixtures = args.audio && args.cues ? loadDirectFixture(args.audio, args.cues) : loadFixtures(args.song)
    if (!fixtures.length) process.exit(1)
    if (args.dumpMap && fixtures.length !== 1) throw new Error("--dump-map requires one fixture; select it with --song or use --audio/--cues")

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
            await runFixture(fixture, variants, opts, rows, configs.length === 1, args.trace, args.dumpMap)
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

    const failures = rows.filter((row) => (args.minCoverage !== undefined && row.score.coveragePct < args.minCoverage) || (args.maxFalse !== undefined && row.score.falseAdvances > args.maxFalse))
    if (failures.length) {
        console.error(`\n${failures.length} run(s) failed the requested quality gates:`)
        for (const row of failures) console.error(`  ${row.song}/${row.variant}: coverage ${row.score.coveragePct}%, false advances ${row.score.falseAdvances}`)
        process.exitCode = 1
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
