// Turns a rolling transcript into a navigation decision.
//
// - Same-show matching: scores the transcript against each slide of the current show using a
//   small per-show token index (rebuilt only when the show changes), reusing the project's
//   formatSearch/tokenize text normalisation.
// - Cross-show matching: reuses the existing global inverted-index `fastSearch` to detect when
//   the band has started a completely different song.
// - Hysteresis + cooldown prevent thrashing and stop the feature fighting the operator.

import { get } from "svelte/store"
import type { ShowList } from "../../../types/Show"
import { getTextLines } from "../../components/edit/scripts/textStyle"
import { shows, showsCache } from "../../stores"
import { formatSearch, tokenize } from "../../utils/search"
import { fastSearch } from "../../utils/searchFast"
import type { AutoLyricsSuggestion } from "./types"

interface SlideEntry {
    index: number
    tokens: Set<string>
    text: string // formatted, space-joined (for phrase checks)
    label: string // first non-empty line, for the suggestion UI
}

export interface MatchContext {
    transcript: string
    currentShowId: string
    currentLayoutId: string
    currentIndex: number
    detectSongSwitch: boolean
    threshold: number
    stableWindows: number
    cooldownMs: number
    now: number
}

export type MatchDecision = { type: "none" } | (AutoLyricsSuggestion & { type: "same-show-slide" | "different-song" })

export class LyricsMatcher {
    private indexedShowKey = ""
    private slides: SlideEntry[] = []

    // hysteresis state
    private candidateIndex = -1
    private candidateCount = 0
    private candidateSongId = ""
    private songCount = 0
    private cooldownUntil = 0
    private missCount = 0

    // Call when a navigation happens (auto, confirmed suggestion, or operator manual move)
    // so the matcher backs off briefly and resets its stability counters.
    notifyNavigation(now: number, cooldownMs: number) {
        this.cooldownUntil = now + cooldownMs
        this.candidateIndex = -1
        this.candidateCount = 0
        this.candidateSongId = ""
        this.songCount = 0
        this.missCount = 0
    }

    private ensureShowIndex(showId: string, layoutId: string) {
        const key = `${showId}::${layoutId}`
        if (key === this.indexedShowKey && this.slides.length) return
        this.indexedShowKey = key
        this.slides = []

        const show = get(showsCache)[showId]
        if (!show) return

        const layoutKey = layoutId || show.settings?.activeLayout
        const order: { id: string }[] = show.layouts?.[layoutKey]?.slides || []

        order.forEach((ref, index) => {
            const slide = show.slides?.[ref.id]
            if (!slide) return
            const lines = getTextLines(slide).filter(Boolean)
            const text = formatSearch(lines.join(" "))
            const tokens = new Set(tokenize(text))
            this.slides.push({ index, tokens, text, label: lines[0] || `Slide ${index + 1}` })
        })
    }

    // Score the transcript against one slide. Returns 0-100 (~ fraction of sung words on the slide,
    // boosted by matching word sequences).
    private scoreSlide(slide: SlideEntry, queryTokens: string[], queryText: string): number {
        const considered = queryTokens.filter((t) => t.length >= 3)
        if (!considered.length) return 0

        let matched = 0
        for (const t of considered) if (slide.tokens.has(t)) matched++

        let phraseBonus = 0
        const words = queryTokens
        for (let i = 0; i < words.length - 1; i++) {
            const bigram = `${words[i]} ${words[i + 1]}`
            if (slide.text.includes(bigram)) phraseBonus += 1
            if (i < words.length - 2) {
                const trigram = `${bigram} ${words[i + 2]}`
                if (slide.text.includes(trigram)) phraseBonus += 1.5
            }
        }

        const coverage = matched / considered.length
        const score = coverage * 100 + phraseBonus * 6
        return Math.min(100, score)
    }

    evaluate(ctx: MatchContext): MatchDecision {
        const queryText = formatSearch(ctx.transcript)
        const queryTokens = tokenize(queryText)
        if (queryTokens.filter((t) => t.length >= 3).length < 2) return { type: "none" }

        // ---- current-show scoring ----
        let bestIndex = -1
        let bestScore = 0
        if (ctx.currentShowId) {
            this.ensureShowIndex(ctx.currentShowId, ctx.currentLayoutId)
            for (const slide of this.slides) {
                const s = this.scoreSlide(slide, queryTokens, queryText)
                if (s > bestScore) {
                    bestScore = s
                    bestIndex = slide.index
                }
            }
        }

        // ---- cross-show scoring (different song detection) ----
        let songCandidate: { id: string; name: string; score: number } | null = null
        if (ctx.detectSongSwitch) {
            const list: ShowList[] = Object.entries(get(shows)).map(([id, s]: any) => ({ id, ...s }))
            const results = fastSearch(ctx.transcript, list)
            const top = results[0]
            if (top && top.id !== ctx.currentShowId) songCandidate = { id: top.id, name: top.name || "", score: top.match || 0 }
        }

        const inCooldown = ctx.now < this.cooldownUntil

        // ---- different song (always a suggestion/toast, never auto-switch) ----
        // Requires the other song to clearly beat the best current-show slide.
        if (songCandidate && songCandidate.score >= 80 && songCandidate.score > bestScore + 20) {
            if (this.candidateSongId === songCandidate.id) this.songCount++
            else {
                this.candidateSongId = songCandidate.id
                this.songCount = 1
            }
            if (this.songCount >= ctx.stableWindows && !inCooldown) {
                return { type: "different-song", showId: songCandidate.id, label: songCandidate.name, confidence: Math.round(songCandidate.score) }
            }
        } else {
            this.candidateSongId = ""
            this.songCount = 0
        }

        // ---- same-show move ----
        if (bestIndex >= 0 && bestScore >= ctx.threshold && bestIndex !== ctx.currentIndex) {
            if (this.candidateIndex === bestIndex) this.candidateCount++
            else {
                this.candidateIndex = bestIndex
                this.candidateCount = 1
            }
            this.missCount = 0

            if (this.candidateCount >= ctx.stableWindows && !inCooldown) {
                const label = this.slides.find((s) => s.index === bestIndex)?.label || `Slide ${bestIndex + 1}`
                return { type: "same-show-slide", showId: ctx.currentShowId, slideIndex: bestIndex, label, confidence: Math.round(bestScore) }
            }
        } else {
            // matched the current slide, or nothing strong -> let any pending suggestion expire
            if (bestIndex === ctx.currentIndex) {
                this.candidateIndex = -1
                this.candidateCount = 0
            } else if (++this.missCount >= ctx.stableWindows) {
                this.candidateIndex = -1
                this.candidateCount = 0
            }
        }

        return { type: "none" }
    }

    reset() {
        this.indexedShowKey = ""
        this.slides = []
        this.notifyNavigation(0, 0)
        this.cooldownUntil = 0
    }
}
