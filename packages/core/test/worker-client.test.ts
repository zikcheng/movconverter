import { describe, expect, it } from 'vitest'
import { canConvertInWorker, convertInWorker } from '../src/worker-client'
import type { ConvertRequest, WorkerLike, WorkerResponse } from '../src/worker-protocol'
import { asBlob, buildMov, type SynthTrackSpec } from './helpers/synth'

const videoTrack: SynthTrackSpec = {
  id: 1,
  handler: 'vide',
  format: 'avc1',
  timescale: 30000,
  sampleDelta: 1001,
  sampleSizes: [100],
  chunkOffsets: [0],
  samplesPerChunk: 1,
}

/**
 * In-process fake Worker: routes protocol messages through the real handler
 * logic by importing the convert functions directly (Node has no Worker DOM).
 */
function makeFakeWorker(): WorkerLike {
  const listeners = new Set<(e: { data: WorkerResponse }) => void>()
  const emit = (data: WorkerResponse) => {
    for (const l of listeners) l({ data })
  }
  return {
    addEventListener: (_type, l) => listeners.add(l),
    removeEventListener: (_type, l) => listeners.delete(l),
    postMessage: (message) => {
      const req = message as ConvertRequest
      void (async () => {
        const { canConvert, convertMovToMp4 } = await import('../src/convert')
        try {
          if (req.type === 'canConvert') {
            emit({ id: req.id, type: 'plan', plan: await canConvert(req.file) })
            return
          }
          emit({ id: req.id, type: 'progress', progress: 0.5 })
          const result = await convertMovToMp4(req.file)
          emit({ id: req.id, type: 'result', ...result })
        } catch (error) {
          const e = error as Error
          emit({ id: req.id, type: 'error', name: e.name, message: e.message })
        }
      })()
    },
  }
}

function movFile(): Blob {
  return asBlob(buildMov({ mdatPayload: new Uint8Array(200), tracks: [videoTrack] }).bytes)
}

describe('worker client protocol', () => {
  it('converts through the message protocol with progress', async () => {
    const progresses: number[] = []
    const result = await convertInWorker(makeFakeWorker(), movFile(), {
      onProgress: (p) => progresses.push(p),
    })
    expect(result.method).toBe('remux')
    expect(result.blob.type).toBe('video/mp4')
    expect(progresses).toContain(0.5)
  })

  it('runs the preflight through the protocol', async () => {
    const plan = await canConvertInWorker(makeFakeWorker(), movFile())
    expect(plan.method).toBe('remux')
  })

  it('propagates errors with their original name', async () => {
    const bad = new Blob([new Uint8Array(4)])
    await expect(convertInWorker(makeFakeWorker(), bad)).rejects.toMatchObject({
      name: 'MovParseError',
    })
  })

  it('ignores responses for other request ids', async () => {
    const worker = makeFakeWorker()
    const [a, b] = await Promise.all([
      convertInWorker(worker, movFile()),
      convertInWorker(worker, movFile()),
    ])
    expect(a.method).toBe('remux')
    expect(b.method).toBe('remux')
  })
})
