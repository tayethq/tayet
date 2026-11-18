import { useCallback, useEffect, useState } from 'react'
import type { Acl, AgentForm, FormId, FormIssue, FormValues, User } from '@tayet/client'

// ADR-103 (Proposto): the agent's form open in this session. The ACL hands it on the global stream
// (form.opened, then form.changed); only the session that clicked the card or sent the command gets it,
// and one at a time. 'done' closes it here (fork I4): the dialog unmounts and the session is free.
// `agent` is the author's User, read from the form's conversation, which may not be the selected one —
// the dialog names and marks the agent from it (P6); undefined while it loads or when it is not found.

export interface AgentFormSlice {
  form: AgentForm | undefined
  agent: User | undefined
  submit: (formId: FormId, values: FormValues) => Promise<{ ok: true } | { issues: Record<string, FormIssue> }>
  close: (formId: FormId) => void
}

export function useAgentForm(acl: Acl): AgentFormSlice {
  const [form, setForm] = useState<AgentForm | undefined>(undefined)
  const [agent, setAgent] = useState<User | undefined>(undefined)

  useEffect(
    () =>
      acl.subscribe((e) => {
        if (e.t === 'form.opened') setForm(e.form)
        else if (e.t === 'form.changed')
          setForm((cur) => (cur?.id !== e.form.id ? cur : e.form.state.kind === 'done' ? undefined : e.form))
      }),
    [acl],
  )

  const channelId = form?.channelId
  const agentId = form?.agent
  useEffect(() => {
    setAgent(undefined)
    if (channelId === undefined || agentId === undefined) return
    let alive = true
    acl
      .getMembers(channelId)
      .then((members) => {
        if (alive) setAgent(members.find((m) => m.user.id === agentId)?.user)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [acl, channelId, agentId])

  const submit = useCallback((formId: FormId, values: FormValues) => acl.submitForm(formId, values), [acl])
  const close = useCallback(
    (formId: FormId) => {
      acl.closeForm(formId)
      setForm((cur) => (cur?.id === formId ? undefined : cur))
    },
    [acl],
  )

  return { form, agent, submit, close }
}
