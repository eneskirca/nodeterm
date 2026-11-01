import { useState } from 'react'

/**
 * An image the user attached to a prompt, in the ⌘M thread: a height-capped thumbnail inside the
 * bubble that a click shows at full size (and a second click shrinks back). The parser hands over
 * only an allowlisted raster type with a base64 payload (`CHAT_IMAGE_TYPES`), so the `data:` URL is
 * never markup. Lazy: a long thread of screenshots decodes only the ones scrolled into view.
 */
export function ChatImage({ mediaType, data }: { mediaType: string; data: string }): JSX.Element {
  const [full, setFull] = useState(false)
  return (
    <img
      className={`term-chat__image${full ? ' term-chat__image--full' : ''}`}
      src={`data:${mediaType};base64,${data}`}
      alt="Attached image"
      loading="lazy"
      onClick={() => setFull((f) => !f)}
    />
  )
}
