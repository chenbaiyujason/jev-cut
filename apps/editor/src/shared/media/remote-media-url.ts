/** Local MAD media remains range-streamable after cache refresh or tab wake-up. */
export function localMediaUrl(value: string): string {
  const url = new URL(value, window.location.origin)
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/mad-media/')) {
    throw new Error('Remote media must use the local MAD service')
  }
  return url.href
}
