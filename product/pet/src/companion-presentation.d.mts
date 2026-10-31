/** Type registrations for the plain-JS pet companion presentation projection (v2 snapshot/event surface). */
export type PresentationResult = {
  applied?: boolean
  resync?: boolean
  duplicate?: boolean
  stale?: boolean
  staleEpoch?: boolean
  reason?: string
}
export type PresentationState = {
  working: boolean
  startedAt: number
  inputSource: string
  waiting: boolean
  queued: number
  mode?: string
  hostEpoch?: string
  snapshotSeq?: number
  lastEventSeq?: number
}
export type CompanionPresentationOptions = {
  show(payload: object): void
  hide(): void
  animate(payload: object): void
  send(path: string, body?: object): Promise<unknown>
  publishQuestion?(view: object | null): void
  setTimer?(callback: () => void): number
  clearTimer?(id: number): void
}
export type CompanionPresentation = {
  applySnapshot(snapshot: object): PresentationResult
  applyEvent(event: object): PresentationResult
  sync(snapshot: object): void
  event(event: object): PresentationResult | void
  notice(text: string, kind?: string, duration?: number, capture?: string, options?: object): void
  capture(status: object): void
  cancelCapture(id: string): boolean
  voice(state: string): void
  syncTaskState(state: object): void
  action(value: object): Promise<void>
  state(): PresentationState
  managePolicies(): Promise<void>
  recoverTask(): Promise<void>
  manageQueue(): Promise<void>
  queue(value: object): void
  voiceAnswer(value: object): Promise<boolean>
  stop(): void
}
export function createCompanionPresentation(options: CompanionPresentationOptions): CompanionPresentation
