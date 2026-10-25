/** Merge login-shell discovery with the current, product-owned runtime contract. */
export function botHostEnvironment(shell: NodeJS.ProcessEnv, owned: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = Object.fromEntries(Object.entries(shell).filter(([name]) => !/^(?:DSH|NISSE|WHALEGIRL)_/u.test(name)))
  for (const [name, value] of Object.entries(owned)) {
    if (name.startsWith('DSH_') || ['NISSE_DSH_LLM_ENTRY', 'WHALEGIRL_LLM_API_KEY', 'OPENCODE_GO_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY'].includes(name)) result[name] = value
  }
  return result
}
