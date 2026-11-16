// The channel label as text (PLANO-RELEASE-PUBLICA §8.66): the mark is its own span, so '#engineering'
// is split across two nodes and a plain getByText('#engineering') no longer finds it — a negative
// query would pass vacuously. This matcher finds the label whose textContent is the whole name.
export const channelLabel =
  (name: string) =>
  (_content: string, el: Element | null): boolean =>
    el?.classList.contains('channel-label') === true && el.textContent === name
