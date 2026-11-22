// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { useState } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import {
  StackProvider,
  useStackBack,
  useStackDialog,
  useStackScreens,
  type HistoryEnv,
  type StackHistoryState,
} from '../../src/ui/stack'

// The React side of the stack: the screens follow the state
// that already exists, a dialog open on a narrow window takes one entry, and the system's back closes
// it. A fake history with explicit landing stands in for the browser's.

function fakeHistory() {
  const entries: unknown[] = [null]
  let index = 0
  const listeners = new Set<(s: unknown) => void>()
  const queued: number[] = []
  const env: HistoryEnv = {
    state: () => entries[index],
    push: (s: StackHistoryState) => {
      entries.splice(index + 1)
      entries.push(s)
      index = entries.length - 1
    },
    go: (d) => void queued.push(d),
    back: () => void queued.push(-1),
    replace: (s: StackHistoryState) => {
      entries[index] = s
    },
    onPop: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  const land = () =>
    act(() => {
      while (queued.length) {
        index = Math.max(0, index + queued.shift()!)
        for (const fn of [...listeners]) fn(entries[index])
      }
    })
  return { env, land, depth: () => index, state: () => entries[index] }
}

afterEach(cleanup)

let api: {
  openSheet: () => void
  image: (on: boolean) => void
  sheetToThread: () => void
  openDialog: () => void
  closeDialog: () => void
  select: (on: boolean) => void
  thread: (on: boolean) => void
  back: () => void
  sheetToEdit: () => void
  edit: (on: boolean) => void
  link: (on: boolean) => void
  state: { dialog: boolean; chat: boolean; thread: boolean; sheet: boolean; image: boolean; edit: boolean; link: boolean }
}

function Harness({ narrow }: { narrow: boolean }) {
  const [dialog, setDialog] = useState(false)
  const [chat, setChat] = useState(false)
  const [thread, setThread] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [image, setImage] = useState(false)
  const [edit, setEdit] = useState(false)
  const [link, setLink] = useState(false)
  useStackScreens({ narrow, chat, thread, onPopChat: () => setChat(false), onPopThread: () => setThread(false) })
  useStackDialog('account', narrow && dialog, () => setDialog(false))
  // The message's action sheet (workspace.md §29 item 4, PLANO-MOBILE R2): the Workspace's own wiring.
  useStackDialog('actions', narrow && sheet, () => setSheet(false))
  // The image screen (workspace.md §23.5 item 2, PLANO-MOBILE §0.14 V4): the Workspace's own wiring.
  useStackDialog('image', narrow && image, () => setImage(false))
  // The bottom composer's edit and the link sheet (PLANO-MOBILE §0.15 E3 b): the Workspace's own wiring.
  useStackDialog('edit', narrow && edit, () => setEdit(false))
  useStackDialog('link', narrow && link, () => setLink(false))
  const back = useStackBack(() => setChat(false))
  api = {
    openSheet: () => setSheet(true),
    image: setImage,
    // "Responder na thread": the sheet closes and the thread opens in the same render.
    sheetToThread: () => {
      setSheet(false)
      setThread(true)
    },
    openDialog: () => setDialog(true),
    closeDialog: () => setDialog(false),
    select: setChat,
    thread: setThread,
    back,
    // "Editar mensagem": the sheet closes and the edit opens in the same render.
    sheetToEdit: () => {
      setSheet(false)
      setEdit(true)
    },
    edit: setEdit,
    link: setLink,
    state: { dialog, chat, thread, sheet, image, edit, link },
  }
  return null
}

function mount(narrow = true) {
  const h = fakeHistory()
  const view = render(
    <StackProvider env={h.env}>
      <Harness narrow={narrow} />
    </StackProvider>,
  )
  return { h, view }
}

describe('stack hooks', () => {
  it('the conversation and its thread push; the system back pops them, top first', () => {
    const { h } = mount()
    act(() => api.select(true))
    act(() => api.thread(true))
    expect(h.depth()).toBe(2)
    act(() => api.back())
    h.land()
    expect(api.state).toMatchObject({ chat: true, thread: false })
    act(() => api.back())
    h.land()
    expect(api.state.chat).toBe(false)
    expect(h.depth()).toBe(0)
  })

  it('a dialog takes an entry; the system back closes it and leaves the screen under it', () => {
    const { h } = mount()
    act(() => api.openDialog())
    expect(h.state()).toEqual({ tayet: 'stack', screen: 'dialog', depth: 1 })
    act(() => api.back())
    h.land()
    expect(api.state.dialog).toBe(false)
    expect(h.depth()).toBe(0)
  })

  it('closing the dialog from its own interface goes back over its entry', () => {
    const { h } = mount()
    act(() => api.openDialog())
    act(() => api.closeDialog())
    h.land()
    expect(h.depth()).toBe(0)
  })

  it('on a wide window neither the screens nor the dialogs touch the history', () => {
    const { h } = mount(false)
    act(() => api.select(true))
    act(() => api.thread(true))
    act(() => api.openDialog())
    expect(h.depth()).toBe(0)
  })

  it('the action sheet is an entry above the conversation; the system back closes it and leaves the conversation', () => {
    const { h } = mount()
    act(() => api.select(true))
    act(() => api.openSheet())
    expect(h.state()).toEqual({ tayet: 'stack', screen: 'dialog', depth: 2 })
    act(() => api.back())
    h.land()
    expect(api.state).toMatchObject({ chat: true, sheet: false })
    expect(h.depth()).toBe(1)
  })

  it('sheet → thread in one render: back over the sheet, then the thread is pushed; the stack ends with the conversation and the thread', () => {
    const { h } = mount()
    act(() => api.select(true))
    act(() => api.openSheet())
    expect(h.depth()).toBe(2)
    act(() => api.sheetToThread())
    h.land()
    expect(h.depth()).toBe(2)
    expect(h.state()).toEqual({ tayet: 'stack', screen: 'thread', depth: 2 })
    expect(api.state).toMatchObject({ chat: true, thread: true, sheet: false })
    act(() => api.back())
    h.land()
    expect(api.state).toMatchObject({ chat: true, thread: false })
    expect(h.depth()).toBe(1)
  })

  it('the image screen is an entry above the conversation; the system back closes it and leaves the conversation', () => {
    const { h } = mount()
    act(() => api.select(true))
    act(() => api.image(true))
    expect(h.state()).toEqual({ tayet: 'stack', screen: 'dialog', depth: 2 })
    act(() => api.back())
    h.land()
    expect(api.state).toMatchObject({ chat: true, image: false })
    expect(h.depth()).toBe(1)
  })

  it('the image screen opened from the thread: closing it from its own interface goes back to the thread', () => {
    const { h } = mount()
    act(() => api.select(true))
    act(() => api.thread(true))
    act(() => api.image(true))
    expect(h.depth()).toBe(3)
    act(() => api.image(false))
    h.land()
    expect(h.depth()).toBe(2)
    expect(h.state()).toEqual({ tayet: 'stack', screen: 'thread', depth: 2 })
    expect(api.state).toMatchObject({ chat: true, thread: true, image: false })
  })

  it('on a wide window the image takes no entry', () => {
    const { h } = mount(false)
    act(() => api.image(true))
    expect(h.depth()).toBe(0)
  })

  it('sheet → edit in one render: the edit is an entry above the conversation; the system back cancels it (E3 b)', () => {
    const { h } = mount()
    act(() => api.select(true))
    act(() => api.openSheet())
    act(() => api.sheetToEdit())
    h.land()
    expect(h.depth()).toBe(2)
    expect(h.state()).toEqual({ tayet: 'stack', screen: 'dialog', depth: 2 })
    expect(api.state).toMatchObject({ chat: true, sheet: false, edit: true })
    act(() => api.back())
    h.land()
    expect(api.state).toMatchObject({ chat: true, edit: false })
    expect(h.depth()).toBe(1)
  })

  it('the edit in the thread: saving it from its own interface goes back to the thread', () => {
    const { h } = mount()
    act(() => api.select(true))
    act(() => api.thread(true))
    act(() => api.edit(true))
    expect(h.depth()).toBe(3)
    act(() => api.edit(false))
    h.land()
    expect(h.state()).toEqual({ tayet: 'stack', screen: 'thread', depth: 2 })
    expect(api.state).toMatchObject({ thread: true, edit: false })
  })

  it('the link sheet over the edit is one more entry; back closes the sheet, then the edit', () => {
    const { h } = mount()
    act(() => api.select(true))
    act(() => api.edit(true))
    act(() => api.link(true))
    expect(h.depth()).toBe(3)
    act(() => api.back())
    h.land()
    expect(api.state).toMatchObject({ edit: true, link: false })
    act(() => api.back())
    h.land()
    expect(api.state).toMatchObject({ chat: true, edit: false })
    expect(h.depth()).toBe(1)
  })

  it('on a wide window neither the edit nor the link takes an entry', () => {
    const { h } = mount(false)
    act(() => api.edit(true))
    act(() => api.link(true))
    expect(h.depth()).toBe(0)
  })

  it('without the provider the back closes by itself', () => {
    render(<Harness narrow />)
    act(() => api.select(true))
    act(() => api.back())
    expect(api.state.chat).toBe(false)
  })
})
