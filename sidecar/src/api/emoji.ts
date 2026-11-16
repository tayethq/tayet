// A reaction's emoji as an argument of the local API: the character itself (the native path segment,
// percent-encoded; the MCP `react` tool). A `:name:` is the Slack layer's (S-f); whitespace, control
// characters and anything over 64 bytes are refused.
export function isEmojiArgument(raw: string): boolean {
  const control = [...raw].some((c) => (c.codePointAt(0) as number) < 0x20)
  return !(raw === '' || Buffer.byteLength(raw, 'utf8') > 64 || /^:[^:\s]+:$/.test(raw) || /\s/.test(raw) || control)
}
