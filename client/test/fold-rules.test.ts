import { describe, it, expect, vi } from 'vitest'
import { ConditionKind, PushRuleActionName, PushRuleKind, type IPushRule } from 'matrix-js-sdk'
import { ensureFoldRules, FOLD_RULES } from '../src/acl/internal/fold-rules'
import { COMMANDS_REL_TYPE, PANEL_REL_TYPE, RESPONSE_REL_TYPE } from '@tayet/shared/internal'

// ADR-091 dec. 10; PLANO-AGENTES §0.3.16 item 9: the `override` rules with no actions that keep an answer
// and a panel out of the unread count — and, since A4-1 (ADR-093 (Proposto), §0.3.21 item 3), the agents'
// commands manifest: three rules. Idempotent (read before write) and tolerant.

const rule = (ruleId: string, relType: string, extra: Partial<IPushRule> = {}): IPushRule => ({
  rule_id: ruleId,
  default: false,
  enabled: true,
  actions: [],
  conditions: [{ kind: ConditionKind.EventPropertyIs, key: 'content.m\\.relates_to.rel_type', value: relType }],
  ...extra,
})

function fakeClient(override: IPushRule[] | (() => never)) {
  return {
    getPushRules: vi.fn(async () => (typeof override === 'function' ? override() : { global: { override } })),
    addPushRule: vi.fn(async (..._args: unknown[]) => ({})),
    setPushRuleEnabled: vi.fn(async (..._args: unknown[]) => ({})),
  }
}
const telemetry = () => ({ untranslated: vi.fn() })

describe('ensureFoldRules', () => {
  it('none in place → writes the three, override, no actions, exact property condition on the relation type', async () => {
    const client = fakeClient([])
    const t = telemetry()
    expect(await ensureFoldRules(client as never, t)).toBe('written')
    expect(client.addPushRule.mock.calls).toEqual(
      [RESPONSE_REL_TYPE, PANEL_REL_TYPE, COMMANDS_REL_TYPE].map((relType, i) => [
        'global',
        PushRuleKind.Override,
        FOLD_RULES[i]!.ruleId,
        { actions: [], conditions: [{ kind: 'event_property_is', key: 'content.m\\.relates_to.rel_type', value: relType }] },
      ]),
    )
    expect(t.untranslated).not.toHaveBeenCalled()
  })

  it('all three in place → reads only, writes nothing (idempotent)', async () => {
    const client = fakeClient(FOLD_RULES.map((r) => rule(r.ruleId, r.relType)))
    expect(await ensureFoldRules(client as never, telemetry())).toBe('present')
    expect(client.getPushRules).toHaveBeenCalledTimes(1)
    expect(client.addPushRule).not.toHaveBeenCalled()
    expect(client.setPushRuleEnabled).not.toHaveBeenCalled()
  })

  it('one disabled → re-enabled; one with another condition or an action → rewritten', async () => {
    const [response, panel, commands] = FOLD_RULES
    const client = fakeClient([
      rule(response!.ruleId, response!.relType, { enabled: false }),
      rule(panel!.ruleId, panel!.relType, { actions: [PushRuleActionName.Notify] }),
      rule(commands!.ruleId, commands!.relType),
    ])
    expect(await ensureFoldRules(client as never, telemetry())).toBe('written')
    expect(client.setPushRuleEnabled).toHaveBeenCalledWith('global', PushRuleKind.Override, response!.ruleId, true)
    expect(client.addPushRule).toHaveBeenCalledTimes(1)
    expect(client.addPushRule.mock.calls[0]![2]).toBe(panel!.ruleId)
  })

  it('three rules: the answer, the panel and the commands manifest, each on its relation type', () => {
    expect(FOLD_RULES.map((r) => r.relType)).toEqual([RESPONSE_REL_TYPE, PANEL_REL_TYPE, COMMANDS_REL_TYPE])
    expect(new Set(FOLD_RULES.map((r) => r.ruleId)).size).toBe(3)
  })

  it('a failure is tolerated: never throws, signals once with no id', async () => {
    const client = fakeClient(() => {
      throw new Error('M_FORBIDDEN @someone:tayet.local')
    })
    const t = telemetry()
    await expect(ensureFoldRules(client as never, t)).resolves.toBe('failed')
    expect(t.untranslated).toHaveBeenCalledTimes(1)
    expect(t.untranslated).toHaveBeenCalledWith({ conceptKind: 'protocol-event', shape: { eventType: 'fold-rules-unwritten' } })
    const writeFails = fakeClient([])
    writeFails.addPushRule.mockRejectedValueOnce(new Error('boom'))
    await expect(ensureFoldRules(writeFails as never, t)).resolves.toBe('failed')
  })
})
