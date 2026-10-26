import { useEffect, useState } from 'react'
/** Bot settings section: embeds the desktop shell's local Bot configuration panel. */
export function BotSettingsSection() {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let active = true
    void (window as Window & { dshDesktop?: { botSettingsUrl(): Promise<string> } }).dshDesktop
      ?.botSettingsUrl()
      .then((value) => {
        if (active) setUrl(value)
      })
    return () => {
      active = false
    }
  }, [])
  if (!url) return null
  return (
    <iframe
      title="Bot settings"
      src={url}
      referrerPolicy="no-referrer"
      style={{
        width: '100%',
        height: '100%',
        minHeight: 520,
        border: 0,
        display: 'block',
        background: 'transparent',
        colorScheme: 'light dark',
      }}
    />
  )
}
