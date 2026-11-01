import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startProgress, onboardingView, reduceOnboarding } from '../src/onboarding.mjs'

for (const stepId of ['llm_key', 'voice_wake']) test(`restart restores actionable ${stepId} instead of interrupted testing`, () => {
  const previous = { ...startProgress(), stepId, substate: 'testing' }
  const resumed = startProgress({ previous })
  assert.notEqual(resumed.substate, 'testing')
  assert.match(resumed.lastError, /中断/)
  const view = onboardingView(resumed)
  assert.ok(view.input || view.choices?.length || view.secondary?.length, 'must offer a way forward')
})
test('completing onboarding opens settings exactly once', () => {
  const result = reduceOnboarding({ ...startProgress(), stepId: 'done' }, { type: 'choice', id: 'open-settings' })
  assert.equal(result.effects.filter(x => x.type === 'open-dsh-settings').length, 1)
})
