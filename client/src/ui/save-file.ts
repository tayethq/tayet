// Hands a resolved url to the system as a download under `name` (PLANO-MOBILE §0.14 V3 a: the download link
// the product already uses, no share sheet). A transient anchor, never left in the document.
export function saveFile(url: string, name: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.hidden = true
  document.body.append(a)
  a.click()
  a.remove()
}
