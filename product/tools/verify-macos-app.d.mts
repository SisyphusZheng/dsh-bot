/** Type registrations for the plain-JS macOS signature helper used by desktop packaging. */
export function machOFiles(root: string): string[]
export function signAdHocResources(resources: string, run?: unknown): { nativeFiles: number; repaired: number }
export function verifyMacApp(app: string, run?: unknown): {
  status: 'PASS'
  scope: string
  nativeFiles: number
  gatekeeper: { status: 'PASS' | 'BLOCKED-EXTERNAL'; detail: string }
}
