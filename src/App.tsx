import { useEffect, useRef, useState } from 'react'
import { Cube3D } from './Cube3D'
import { CubeNet } from './CubeNet'
import { SOLVED_STATE, validateState } from './cube'
import type { Face } from './cube'
import { loadImageToBuffer } from './imageLoader'
import { describeMove, parseMove, stickerIndicesForFace } from './moves'
import { parseNet } from './parser'
import { decodeStateFromHash, shareUrl } from './share'
import {
  applyMoves,
  initSolver,
  isSolverReady,
  randomState,
  solve,
  solveTight,
  terminateSolver,
} from './solver'
import './App.css'

type SolverStatus = 'initializing' | 'ready'
type SolveError = { message: string }
type PlaySpeed = 'slow' | 'normal' | 'fast'
type SolveMode = 'fast' | 'tight'
type TightInfo = { baseline: number; current: number }

const SPEED_MS: Record<PlaySpeed, number> = {
  slow: 1500,
  normal: 700,
  fast: 300,
}

/** Soft deadline in the worker — between calls, stop trying to tighten further. */
const TIGHT_DEADLINE_MS = 6000
/** Hard deadline on the main thread. If a single cubejs.solve() call blows
 * through the soft deadline, the worker is terminated and we fall back to
 * the latest progress result. The worker is then re-initialised in the
 * background (~3s) so the next solve isn't penalised. */
const TIGHT_HARD_TIMEOUT_MS = 9000

const LS_MOVES_SAVED = 'rubiks-solver:moves-saved'
const LS_TIGHT_COUNT = 'rubiks-solver:tight-count'

function readNumber(key: string): number {
  const raw = typeof window !== 'undefined' ? localStorage.getItem(key) : null
  const n = raw ? parseInt(raw, 10) : 0
  return Number.isFinite(n) ? n : 0
}

function readInitialState(): string {
  if (typeof window === 'undefined') return SOLVED_STATE
  return decodeStateFromHash(window.location.hash) ?? SOLVED_STATE
}

function App() {
  const [state, setState] = useState(readInitialState)
  const [solverStatus, setSolverStatus] = useState<SolverStatus>(
    isSolverReady() ? 'ready' : 'initializing',
  )
  const [parseError, setParseError] = useState<string | null>(null)
  const [moves, setMoves] = useState<string[] | null>(null)
  const [solveMode, setSolveMode] = useState<SolveMode | null>(null)
  const [tightInfo, setTightInfo] = useState<TightInfo | null>(null)
  const [solveBusy, setSolveBusy] = useState<SolveMode | null>(null)
  const [solveError, setSolveError] = useState<SolveError | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [autoPlay, setAutoPlay] = useState(false)
  const [playSpeed, setPlaySpeed] = useState<PlaySpeed>('normal')
  const [shareFeedback, setShareFeedback] = useState<string | null>(null)
  const [savedTotals, setSavedTotals] = useState({
    movesSaved: readNumber(LS_MOVES_SAVED),
    tightCount: readNumber(LS_TIGHT_COUNT),
  })
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    initSolver().then(() => setSolverStatus('ready'))
  }, [])

  // stateRef tracks the latest committed state so async solve handlers can
  // detect whether the cube changed during their await window and discard
  // stale results.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  const solveBusyRef = useRef<SolveMode | null>(null)
  useEffect(() => {
    solveBusyRef.current = solveBusy
  }, [solveBusy])

  function setStateAndClearMoves(next: string) {
    // If a solve is in flight when the cube state changes (random scramble,
    // reset, sticker edit, paste, drop), terminate the worker so its result
    // doesn't arrive later and overwrite the new state with stale moves.
    // The worker re-spawns + re-inits transparently on the next solve.
    if (solveBusyRef.current) {
      terminateSolver()
      setSolveBusy(null)
      setTightInfo(null)
      setSolverStatus('initializing')
      initSolver().then(() => setSolverStatus('ready'))
    }
    setState(next)
    setMoves(null)
    setSolveMode(null)
    setTightInfo(null)
    setSolveError(null)
    setStepIndex(0)
    setAutoPlay(false)
  }

  async function handleFile(file: File) {
    setParseError(null)
    try {
      const img = await loadImageToBuffer(file)
      const result = parseNet(img)
      if (!result.ok) {
        setParseError(result.reason)
        return
      }
      setStateAndClearMoves(result.state)
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err))
    }
  }

  // Paste image from clipboard (⌘V / Ctrl+V) anywhere on the page.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items
      if (!items) return
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            handleFile(file)
            return
          }
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Drag-and-drop image upload anywhere on the page.
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    let dragCount = 0
    function onDragEnter(e: DragEvent) {
      if (!e.dataTransfer?.types.includes('Files')) return
      dragCount++
      setDragging(true)
    }
    function onDragLeave() {
      dragCount = Math.max(0, dragCount - 1)
      if (dragCount === 0) setDragging(false)
    }
    function onDragOver(e: DragEvent) {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    function onDrop(e: DragEvent) {
      e.preventDefault()
      dragCount = 0
      setDragging(false)
      const file = e.dataTransfer?.files?.[0]
      if (file && file.type.startsWith('image/')) handleFile(file)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keyboard nav through the solution.
  useEffect(() => {
    if (!moves) return
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        setAutoPlay(false)
        setStepIndex((i) => Math.min(moves!.length, i + 1))
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setAutoPlay(false)
        setStepIndex((i) => Math.max(0, i - 1))
      } else if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault()
        setAutoPlay((p) => !p)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moves])

  // Auto-play tick.
  useEffect(() => {
    if (!autoPlay || !moves) return
    if (stepIndex >= moves.length) {
      setAutoPlay(false)
      return
    }
    const id = window.setTimeout(() => {
      setStepIndex((i) => Math.min(moves.length, i + 1))
    }, SPEED_MS[playSpeed])
    return () => window.clearTimeout(id)
  }, [autoPlay, stepIndex, moves, playSpeed])

  const validation = validateState(state)
  const canSolve = validation.ok && solverStatus === 'ready' && !solveBusy

  const displayState = moves ? applyMoves(state, moves.slice(0, stepIndex)) : state
  const upcomingMove =
    moves && stepIndex < moves.length ? parseMove(moves[stepIndex]) : null
  const highlight = upcomingMove ? stickerIndicesForFace(upcomingMove.face) : []

  function handleStickerChange(index: number, nextFace: Face) {
    setStateAndClearMoves(state.slice(0, index) + nextFace + state.slice(index + 1))
  }

  async function handleSolveFast() {
    setSolveError(null)
    setMoves(null)
    setSolveMode(null)
    setTightInfo(null)
    setStepIndex(0)
    setAutoPlay(false)
    setSolveBusy('fast')
    const requestState = state
    try {
      const result = await solve(requestState)
      // Belt-and-suspenders: if the cube changed under us (and the worker
      // wasn't terminated for some reason), don't apply stale moves.
      if (stateRef.current !== requestState) return
      setMoves(result)
      setSolveMode('fast')
    } catch (err) {
      if (stateRef.current !== requestState) return
      const message = err instanceof Error ? err.message : String(err)
      if (message !== 'Solver cancelled') setSolveError({ message })
    } finally {
      setSolveBusy(null)
    }
  }

  async function handleSolveTight() {
    setSolveError(null)
    setMoves(null)
    setSolveMode(null)
    setTightInfo(null)
    setStepIndex(0)
    setAutoPlay(false)
    setSolveBusy('tight')

    const requestState = state
    let baseline = 0
    let latestProgress: string[] | null = null
    let timedOut = false

    // Hard timeout: if a single solve() call inside the worker blows past
    // the soft deadline (~6s) we terminate the worker and recover with the
    // best progress we've heard so far.
    const hardTimer = window.setTimeout(() => {
      timedOut = true
      terminateSolver()
      if (stateRef.current === requestState) {
        if (latestProgress) {
          setMoves(latestProgress)
          setSolveMode('tight')
          setTightInfo({ baseline, current: latestProgress.length })
          const saved = Math.max(0, baseline - latestProgress.length)
          if (saved > 0) bumpSavedTotals(saved)
        } else {
          setSolveError({
            message: `Tight solve timed out after ${TIGHT_HARD_TIMEOUT_MS / 1000}s with no result. Try Solve (fast) or Random scramble.`,
          })
        }
      }
      setSolveBusy(null)
      setSolverStatus('initializing')
      initSolver().then(() => setSolverStatus('ready'))
    }, TIGHT_HARD_TIMEOUT_MS)

    try {
      const result = await solveTight(requestState, {
        deadlineMs: TIGHT_DEADLINE_MS,
        onProgress: ({ moves: m, phase }) => {
          if (stateRef.current !== requestState) return
          if (phase === 'baseline') baseline = m.length
          latestProgress = m
          setTightInfo({ baseline, current: m.length })
        },
      })
      window.clearTimeout(hardTimer)
      if (timedOut) return
      if (stateRef.current !== requestState) return
      setMoves(result)
      setSolveMode('tight')
      setTightInfo({ baseline, current: result.length })
      const saved = Math.max(0, baseline - result.length)
      if (saved > 0) bumpSavedTotals(saved)
    } catch (err) {
      window.clearTimeout(hardTimer)
      if (timedOut) return
      if (stateRef.current !== requestState) return
      const message = err instanceof Error ? err.message : String(err)
      if (message !== 'Solver cancelled') setSolveError({ message })
    } finally {
      if (!timedOut) setSolveBusy(null)
    }
  }

  function bumpSavedTotals(saved: number) {
    const newSaved = savedTotals.movesSaved + saved
    const newCount = savedTotals.tightCount + 1
    localStorage.setItem(LS_MOVES_SAVED, String(newSaved))
    localStorage.setItem(LS_TIGHT_COUNT, String(newCount))
    setSavedTotals({ movesSaved: newSaved, tightCount: newCount })
  }

  function handleCancelTight() {
    terminateSolver()
    setSolveBusy(null)
    setTightInfo(null)
    setSolverStatus('initializing')
    initSolver().then(() => setSolverStatus('ready'))
  }

  async function handleShare() {
    const url = shareUrl(state)
    try {
      await navigator.clipboard.writeText(url)
      setShareFeedback('Link copied!')
    } catch {
      setShareFeedback(url)
    }
    window.setTimeout(() => setShareFeedback(null), 2500)
  }

  function manualSetStep(next: number) {
    setAutoPlay(false)
    setStepIndex(next)
  }

  return (
    <main className={dragging ? 'dragging' : undefined}>
      <header>
        <h1>RubikSolver</h1>
        <p className="tagline">
          Upload, paste, or drop an unfolded-net image of a scrambled cube — get a
          step-by-step solution.
        </p>
      </header>

      <section className="toolbar">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
            e.target.value = ''
          }}
        />
        <button onClick={() => fileInputRef.current?.click()}>Upload net image</button>
        <button onClick={() => setStateAndClearMoves(randomState())}>Random scramble</button>
        <button onClick={() => setStateAndClearMoves(SOLVED_STATE)}>Reset</button>
        <button onClick={handleShare} title="Copy a link that reproduces this exact state">
          Share
        </button>
        <span
          className={`status status-${solverStatus}`}
          role="status"
          aria-live="polite"
        >
          Solver: {solverStatus === 'ready' ? 'ready' : 'initializing…'}
        </span>
      </section>

      {shareFeedback && (
        <p className="share-feedback" role="status" aria-live="polite">
          {shareFeedback}
        </p>
      )}
      {parseError && (
        <p className="error" role="alert">
          Image parse error: {parseError}
        </p>
      )}

      <section className="cube-area">
        <div className="cube-net">
          <CubeNet
            state={displayState}
            editable={!moves && !solveBusy}
            onChange={handleStickerChange}
            highlightIndices={highlight}
          />
        </div>
        <div className="cube-3d">
          <Cube3D state={displayState} />
        </div>
      </section>

      {!moves && !solveBusy && (
        <section className="validation">
          {validation.ok ? (
            <p className="valid">
              Valid cube state — click any sticker to fix a wrong color. Tip: paste
              (⌘V) or drop a net image anywhere on the page.
            </p>
          ) : (
            <p className="invalid">Invalid: {validation.reason}</p>
          )}
        </section>
      )}

      {!moves && (
        <section className="solve-area">
          <button
            className="primary"
            disabled={!canSolve}
            onClick={handleSolveFast}
            title={!canSolve && !validation.ok ? validation.reason : 'Fast Kociemba solve (typically 20–22 moves, instant).'}
          >
            {solveBusy === 'fast' ? 'Solving…' : 'Solve'}
          </button>
          <button
            className="secondary"
            disabled={!canSolve}
            onClick={handleSolveTight}
            title={`Aims for God's Number (≤20 moves). Iterates Kociemba at tighter depths for up to ${TIGHT_DEADLINE_MS / 1000}s.`}
          >
            {solveBusy === 'tight' ? 'Tightening…' : 'Solve (tightest)'}
          </button>
          {solveBusy === 'tight' && tightInfo && (
            <span className="tight-progress" role="status" aria-live="polite">
              baseline {tightInfo.baseline}, best so far {tightInfo.current}
            </span>
          )}
          {solveBusy === 'tight' && (
            <button className="cancel" onClick={handleCancelTight}>
              Cancel
            </button>
          )}
          {solveError && (
            <p className="error" role="alert">
              {solveError.message}
            </p>
          )}
        </section>
      )}

      {moves && moves.length > 0 && solveMode === 'tight' && tightInfo && tightInfo.baseline > tightInfo.current && (
        <p className="tight-banner" role="status" aria-live="polite">
          Found a {tightInfo.current}-move solution — saved {tightInfo.baseline - tightInfo.current} vs. the {tightInfo.baseline}-move baseline.
        </p>
      )}
      {moves && moves.length > 0 && solveMode === 'tight' && tightInfo && tightInfo.baseline === tightInfo.current && (
        <p className="tight-banner muted" role="status" aria-live="polite">
          Couldn't find anything shorter than {tightInfo.current} moves within {TIGHT_DEADLINE_MS / 1000}s — Kociemba's first solution was already locally optimal.
        </p>
      )}

      {moves && moves.length === 0 && (
        <p className="already-solved" role="status" aria-live="polite">
          The cube is already solved — no moves needed.
        </p>
      )}

      {moves && moves.length > 0 && (
        <Solution
          moves={moves}
          stepIndex={stepIndex}
          setStepIndex={manualSetStep}
          autoPlay={autoPlay}
          setAutoPlay={setAutoPlay}
          playSpeed={playSpeed}
          setPlaySpeed={setPlaySpeed}
        />
      )}

      <footer>
        <Notation />
        {savedTotals.tightCount > 0 && (
          <p className="saved-counter">
            Lifetime: {savedTotals.movesSaved} move{savedTotals.movesSaved === 1 ? '' : 's'} saved
            across {savedTotals.tightCount} tight solve{savedTotals.tightCount === 1 ? '' : 's'}.
          </p>
        )}
      </footer>
    </main>
  )
}

function Solution({
  moves,
  stepIndex,
  setStepIndex,
  autoPlay,
  setAutoPlay,
  playSpeed,
  setPlaySpeed,
}: {
  moves: string[]
  stepIndex: number
  setStepIndex: (n: number) => void
  autoPlay: boolean
  setAutoPlay: (next: boolean | ((prev: boolean) => boolean)) => void
  playSpeed: PlaySpeed
  setPlaySpeed: (s: PlaySpeed) => void
}) {
  const completed = stepIndex >= moves.length
  const upcoming = !completed ? parseMove(moves[stepIndex]) : null
  const speeds: PlaySpeed[] = ['slow', 'normal', 'fast']
  return (
    <section className="solution">
      <h2>
        Solution: {moves.length} {moves.length === 1 ? 'move' : 'moves'}
      </h2>
      <p className="move-list">
        {moves.map((m, i) => {
          const cls =
            i < stepIndex
              ? 'move done'
              : i === stepIndex
                ? 'move current'
                : 'move'
          return (
            <span key={i} className={cls}>
              {m}
            </span>
          )
        })}
      </p>
      <div className="step-controls">
        <button
          onClick={() => setStepIndex(Math.max(0, stepIndex - 1))}
          disabled={stepIndex === 0}
        >
          ← Prev
        </button>
        <button
          className="play-toggle"
          onClick={() => setAutoPlay((p) => !p)}
          disabled={completed}
          aria-pressed={autoPlay}
        >
          {autoPlay ? '⏸ Pause' : '▶ Play'}
        </button>
        <span className="step-status">
          {completed ? (
            <>Solved! All {moves.length} moves applied.</>
          ) : (
            <>
              Move {stepIndex + 1} of {moves.length}
              {upcoming && <span className="step-detail"> — {describeMove(upcoming)}</span>}
            </>
          )}
        </span>
        <button
          onClick={() => setStepIndex(Math.min(moves.length, stepIndex + 1))}
          disabled={stepIndex >= moves.length}
        >
          Next →
        </button>
      </div>
      <div className="speed-controls">
        <span className="speed-label">Speed:</span>
        {speeds.map((s) => (
          <button
            key={s}
            className={`speed ${s === playSpeed ? 'active' : ''}`}
            onClick={() => setPlaySpeed(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <p className="step-hint">Tip: ← / → to step, space to play/pause.</p>
    </section>
  )
}

function Notation() {
  return (
    <details className="notation">
      <summary>Notation legend</summary>
      <ul>
        <li>
          <code>U</code>, <code>D</code>, <code>L</code>, <code>R</code>, <code>F</code>,
          <code>B</code> — Up, Down, Left, Right, Front, Back face
        </li>
        <li>Bare letter = 90° clockwise (looking at that face from outside the cube)</li>
        <li>
          <code>'</code> suffix = 90° counter-clockwise (e.g. <code>R'</code>)
        </li>
        <li>
          <code>2</code> suffix = 180° (e.g. <code>F2</code>)
        </li>
      </ul>
    </details>
  )
}

export default App
