import { useEffect, useState } from 'react'
import { useMachineStore } from '../store/useMachineStore'

/**
 * Re-render trigger for panels that show live machine values (positions, matrices,
 * current line). Follows `store.version`, but while playback runs it updates at most
 * `hz` times per second, so 60 fps playback does not re-render the React tree every
 * frame. Manual jogging (not playing) updates immediately.
 */
export function useLiveVersion(hz = 10): number {
  const [v, setV] = useState(() => useMachineStore.getState().version)
  useEffect(() => {
    let last = 0
    let timer: number | undefined
    const flush = () => {
      timer = undefined
      last = performance.now()
      setV(useMachineStore.getState().version)
    }
    const unsub = useMachineStore.subscribe((s, prev) => {
      if (s.version === prev.version && s.isPlaying === prev.isPlaying) return
      const wait = 1000 / hz - (performance.now() - last)
      if (!s.isPlaying || wait <= 0) {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined }
        flush()
      } else if (timer === undefined) {
        timer = window.setTimeout(flush, wait)
      }
    })
    return () => { unsub(); if (timer !== undefined) clearTimeout(timer) }
  }, [hz])
  return v
}
