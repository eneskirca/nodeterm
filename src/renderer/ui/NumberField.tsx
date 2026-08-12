import { cn } from './cn'

export function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  className,
  disabled,
  ariaLabel
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  className?: string
  disabled?: boolean
  ariaLabel?: string
}): React.JSX.Element {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(Number(e.target.value))}
      className={cn(
        'h-8 w-24 rounded-md border border-border bg-bg px-2.5 text-[13px] text-text outline-none focus:border-accent',
        disabled && 'opacity-40',
        className
      )}
    />
  )
}
