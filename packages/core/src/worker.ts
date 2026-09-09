import { canConvert, convertMovToMp4 } from './convert'
import type { ConvertRequest, WorkerResponse } from './worker-protocol'

interface WorkerScope {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (e: { data: ConvertRequest }) => void): void
  document?: unknown
}

function isWorkerScope(g: unknown): g is WorkerScope {
  const scope = g as WorkerScope
  return (
    typeof scope.postMessage === 'function' &&
    typeof scope.addEventListener === 'function' &&
    scope.document === undefined
  )
}

async function handle(scope: WorkerScope, req: ConvertRequest): Promise<void> {
  const respond = (response: WorkerResponse) => scope.postMessage(response)
  try {
    if (req.type === 'canConvert') {
      respond({ id: req.id, type: 'plan', plan: await canConvert(req.file) })
      return
    }
    const opts: Parameters<typeof convertMovToMp4>[1] = {
      onProgress: (progress) => respond({ id: req.id, type: 'progress', progress }),
    }
    if (req.audioBitrate !== undefined) opts.audioBitrate = req.audioBitrate
    const result = await convertMovToMp4(req.file, opts)
    respond({
      id: req.id,
      type: 'result',
      blob: result.blob,
      method: result.method,
      plan: result.plan,
    })
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error))
    respond({ id: req.id, type: 'error', name: e.name, message: e.message })
  }
}

if (isWorkerScope(globalThis)) {
  const scope = globalThis as unknown as WorkerScope
  scope.addEventListener('message', (e) => {
    if (e.data !== null && typeof e.data === 'object' && typeof e.data.id === 'number') {
      void handle(scope, e.data)
    }
  })
}
