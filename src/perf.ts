// Here we do our perf marks.
import {} from '@electricui/build-rollup-config'

export function mark(name: string) {
  if (__DEV__) performance.mark(name)
}

export function measure(start: string) {
  if (__DEV__) performance.measure(start, start)
}

export function measurePair(name: string, start: string, end: string) {
  if (__DEV__) performance.measure(name, start, end)
}
