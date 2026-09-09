import type { ConvertResult } from './convert'
import type { ConversionPlan } from './inspector'
import type { ConvertRequest, WorkerLike, WorkerResponse } from './worker-protocol'

export interface WorkerConvertOptions {
  onProgress?: (progress: number) => void
  signal?: AbortSignal
  audioBitrate?: number
}

let nextRequestId = 1

function request<T>(
  worker: WorkerLike,
  message: Omit<ConvertRequest, 'id'>,
  opts: WorkerConvertOptions,
  pick: (response: WorkerResponse) => T | undefined,
): Promise<T> {
  const id = nextRequestId++
  return new Promise<T>((resolve, reject) => {
    const onMessage = (e: { data: WorkerResponse }) => {
      const data = e.data
      if (data.id !== id) return
      if (data.type === 'progress') {
        opts.onProgress?.(data.progress)
        return
      }
      worker.removeEventListener('message', onMessage)
      if (data.type === 'error') {
        const error = new Error(data.message)
        error.name = data.name
        reject(error)
        return
      }
      const value = pick(data)
      if (value !== undefined) resolve(value)
    }
    opts.signal?.addEventListener('abort', () => {
      worker.removeEventListener('message', onMessage)
      reject(opts.signal?.reason ?? new Error('aborted'))
    })
    worker.addEventListener('message', onMessage)
    worker.postMessage({ id, ...message })
  })
}

/**
 * Run the conversion inside a Worker created from `movconverter/worker`:
 *
 * ```ts
 * const worker = new Worker(new URL('movconverter/worker', import.meta.url), { type: 'module' })
 * const result = await convertInWorker(worker, file, { onProgress })
 * ```
 */
export function convertInWorker(
  worker: WorkerLike,
  file: Blob,
  opts: WorkerConvertOptions = {},
): Promise<ConvertResult> {
  const message: Omit<ConvertRequest, 'id'> = { type: 'convert', file }
  if (opts.audioBitrate !== undefined) message.audioBitrate = opts.audioBitrate
  return request(worker, message, opts, (r) =>
    r.type === 'result' ? { blob: r.blob, method: r.method, plan: r.plan } : undefined,
  )
}

/** Run the canConvert preflight inside the worker. */
export function canConvertInWorker(worker: WorkerLike, file: Blob): Promise<ConversionPlan> {
  return request(worker, { type: 'canConvert', file }, {}, (r) =>
    r.type === 'plan' ? r.plan : undefined,
  )
}
