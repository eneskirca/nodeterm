import type { ButtonHTMLAttributes } from 'react'
import { cn } from './cn'

type Variant = 'default' | 'primary' | 'ghost'

export function Button({
  variant = 'default',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        // The base declares the border WIDTH only and every variant names its own colour, because
        // two border-colour utilities on one element are decided by their order in Tailwind's
        // output rather than by the order they are listed here. Tailwind's preflight is
        // deliberately not loaded (see tailwind.css), so a variant that declares no border at all
        // keeps the browser's own: primary rendered with a light UA ring around the accent fill,
        // and sat 2px taller than the bordered `default` beside it.
        'inline-flex cursor-pointer items-center justify-center rounded-md border px-3 py-1.5 text-[13px] font-medium outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'border-transparent bg-accent text-white hover:bg-accent-hover',
        variant === 'ghost' && 'border-transparent bg-transparent text-muted hover:text-text',
        // `bg-fill-weak` rather than a literal white overlay: that token exists so a hover does
        // not turn into a white smear the moment the surface under it is the light theme.
        variant === 'default' && 'border-border bg-panel-header text-text hover:bg-fill-weak',
        className
      )}
      {...rest}
    />
  )
}
