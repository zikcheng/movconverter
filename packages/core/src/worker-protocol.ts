import type { ConversionMethod, ConversionPlan } from './inspector'

export interface ConvertRequest {
  id: number
  type: 'convert' | 'canConvert'
  file: Blob
  audioBitrate?: number
}

export type WorkerResponse =
  | { id: number; type: 'progress'; progress: number }
  | { id: number; type: 'plan'; plan: ConversionPlan }
  | { id: number; type: 'result'; blob: Blob; method: ConversionMethod; plan: ConversionPlan }
  | { id: number; type: 'error'; name: string; message: string }

/** The subset of the Worker interface the client wrapper needs. */
export interface WorkerLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (e: { data: WorkerResponse }) => void): void
  removeEventListener(type: 'message', listener: (e: { data: WorkerResponse }) => void): void
}
