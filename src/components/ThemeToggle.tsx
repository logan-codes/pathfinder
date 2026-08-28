import { Monitor, Moon, Sun } from 'lucide-react'
import { useAppStore, type ThemeChoice } from '@/store/useAppStore'

const OPTIONS: Array<{ value: ThemeChoice; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
]

/**
 * Three explicit states rather than a two-way switch: "follow the OS" is a
 * real preference, and a binary toggle cannot express it.
 */
export function ThemeToggle() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)

  return (
    <div className="themetoggle" role="group" aria-label="Colour theme">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
        >
          <Icon size={14} strokeWidth={2} />
        </button>
      ))}
    </div>
  )
}
