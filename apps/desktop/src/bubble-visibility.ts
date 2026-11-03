/** Bubble ownership between the onboarding overlay and the presentation layer. */

/**
 * Whether the onboarding overlay may take the bubble away from the presentation layer.
 *
 * A pending approval or question blocks the agent, so an overlay must never hide it: doing so strands
 * the turn until the product approval timeout cancels it. Everything else stays overlay-owned, which is
 * why the overlay keeps the bubble during first-run guidance.
 * @param onboarding - whether the onboarding overlay is currently active.
 * @param blockingInteraction - whether the presentation has a pending approval or question.
 * @returns true when the overlay owns the bubble and the presentation must not show its payload.
 */
export function onboardingOwnsBubble(onboarding: boolean, blockingInteraction: boolean): boolean {
  return onboarding && !blockingInteraction
}

/**
 * Whether the presentation may take the bubble back down while onboarding is active.
 *
 * A resolving interaction clears its pending flag but the overlay is still running, so the bubble would
 * otherwise keep showing a request the user already answered.
 * @param onboarding - whether the onboarding overlay is currently active.
 * @param showingInteraction - whether the bubble currently shows an approval or question.
 * @returns true when the presentation may hide the bubble.
 */
export function presentationMayHideBubble(onboarding: boolean, showingInteraction: boolean): boolean {
  return !onboarding || showingInteraction
}
