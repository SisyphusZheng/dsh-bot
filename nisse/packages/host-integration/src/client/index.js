/** Select the pet's actual Session through the official workspace navigation service. */
export const inject = ['uiWorkspace', 'sessions']

export function apply(ctx) {
  const desktop = globalThis.dshDesktop
  if (!desktop?.onPetSession) return
  ctx.effect(() => {
    let requested
    const select = () => {
      const snapshot = ctx.sessions.list.getSnapshot()
      if (!requested || snapshot.phase !== 'ready' || !snapshot.byId[requested]) return
      const sessionId = requested
      requested = undefined
      ctx.uiWorkspace.openSession(sessionId)
    }
    const stopList = ctx.sessions.list.subscribe(select)
    const stopDesktop = desktop.onPetSession(sessionId => { requested = sessionId; select() })
    return () => { requested = undefined; stopDesktop(); stopList() }
  }, 'dsh-bot: pet Session navigation')
}
