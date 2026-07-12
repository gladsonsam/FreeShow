// Records one pass through a song: the chroma timeline plus a mark for every slide
// change. The first (manual) pass teaches the follower; later passes can replace the
// stored map when the operator had to correct the follower (their timing wins).

import { CHROMA_DIM, CHROMA_FPS, type ChromaFrame } from "./chromaFeatures"
import type { SongMap, SongMark } from "./songMap"
import { quantizeEnergy, quantizeVec, songMapKey } from "./songMap"

// don't record forever if someone leaves a slide up (20 min cap)
const MAX_FRAMES = CHROMA_FPS * 60 * 20
// a useful pass covers at least 2 slides and ~30 seconds of audio
const MIN_FRAMES = CHROMA_FPS * 30
const MIN_SLIDES_COVERED = 2

export class PassRecorder {
    private chromaBytes: number[] = []
    private energyBytes: number[] = []
    private marks: SongMark[] = []
    private frameCount = 0
    manualMoves = 0

    record(frame: ChromaFrame) {
        if (this.frameCount >= MAX_FRAMES) return
        const q = quantizeVec(frame.chroma)
        for (let d = 0; d < CHROMA_DIM; d++) this.chromaBytes.push(q[d])
        this.energyBytes.push(quantizeEnergy(frame.energy))
        this.frameCount++
    }

    markSlide(slideIndex: number, manual: boolean) {
        const last = this.marks[this.marks.length - 1]
        if (last && last.slideIndex === slideIndex) return
        this.marks.push({ frame: this.frameCount, slideIndex })
        if (manual && this.marks.length > 1) this.manualMoves++
    }

    get frames() {
        return this.frameCount
    }

    coveredSlides(): number {
        return new Set(this.marks.map((m) => m.slideIndex)).size
    }

    isUsable(): boolean {
        return this.frameCount >= MIN_FRAMES && this.marks.length >= 2 && this.coveredSlides() >= MIN_SLIDES_COVERED
    }

    toSongMap(meta: { showId: string; layoutId: string; slideCount: number; textHash: string; manualPass: boolean }): SongMap {
        return {
            key: songMapKey(meta.showId, meta.layoutId),
            showId: meta.showId,
            layoutId: meta.layoutId,
            fps: CHROMA_FPS,
            frameCount: this.frameCount,
            chroma: Uint8Array.from(this.chromaBytes),
            energy: Uint8Array.from(this.energyBytes),
            marks: [...this.marks],
            slideCount: meta.slideCount,
            textHash: meta.textHash,
            recordedAt: Date.now(),
            manualPass: meta.manualPass
        }
    }
}
