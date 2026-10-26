/** Select the pet's actual Session through the official workspace navigation service. */
export const inject = ['uiWorkspace']

export function apply(ctx) {
  const desktop = globalThis.dshDesktop
  if (!desktop?.onPetSession) return
  ctx.effect(() => desktop.onPetSession(sessionId => ctx.uiWorkspace.openSession(sessionId)), 'dsh-bot: pet Session navigation')
}
