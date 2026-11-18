import { ConditionKind, PushRuleKind, type IPushRule, type MatrixClient } from 'matrix-js-sdk'
import type { AclTelemetry } from '@tayet/shared'
import { COMMANDS_REL_TYPE, FORM_REL_TYPE, PANEL_REL_TYPE, RESPONSE_REL_TYPE } from '@tayet/shared/internal'

// ADR-091 dec. 10; PLANO-AGENTES §0.3.16 item 9: the answer to an approval card and the pinned
// panel never count as unread — nor the agents' commands manifest (ADR-093 (Proposto), PLANO-AGENTES
// §0.3.21 item 3: one rule more, by its relation type). Three `override` rules on the person's account, with NO actions, each with
// an exact property condition on the relation type in clear — so the server's count skips them in a
// group and in a DM, and an ordinary message is untouched (P-A3-3). The ACL ensures them on connect:
// idempotent (it reads before writing) and tolerant (a failure never takes the connection down; the
// signal carries no id).

const RELATION_KEY = 'content.m\\.relates_to.rel_type'

export const FOLD_RULES: ReadonlyArray<{ ruleId: string; relType: string }> = [
  { ruleId: 'io.tayet.fold.response', relType: RESPONSE_REL_TYPE },
  { ruleId: 'io.tayet.fold.panel', relType: PANEL_REL_TYPE },
  { ruleId: 'io.tayet.fold.commands', relType: COMMANDS_REL_TYPE },
  // The three messages of an agent's form, by their relation type.
  { ruleId: 'io.tayet.fold.form', relType: FORM_REL_TYPE },
]

export type FoldRulesClient = Pick<MatrixClient, 'getPushRules' | 'addPushRule' | 'setPushRuleEnabled'>

// A rule already in place is one with exactly this condition and no action.
function inPlace(rule: IPushRule | undefined, relType: string): boolean {
  if (!rule || rule.actions.length !== 0) return false
  const conds = rule.conditions ?? []
  const only = conds.length === 1 ? conds[0] : undefined
  return only?.kind === ConditionKind.EventPropertyIs && only.key === RELATION_KEY && only.value === relType
}

// 'written' = at least one rule was (re)written or re-enabled; 'present' = all already in place;
// 'failed' = the read or a write failed (signalled, swallowed).
export async function ensureFoldRules(client: FoldRulesClient, telemetry: AclTelemetry): Promise<'written' | 'present' | 'failed'> {
  try {
    const rules = await client.getPushRules()
    const overrides = rules.global.override ?? []
    let wrote = false
    for (const { ruleId, relType } of FOLD_RULES) {
      const current = overrides.find((r) => r.rule_id === ruleId)
      if (inPlace(current, relType)) {
        if (current && !current.enabled) {
          await client.setPushRuleEnabled('global', PushRuleKind.Override, ruleId, true)
          wrote = true
        }
        continue
      }
      await client.addPushRule('global', PushRuleKind.Override, ruleId, {
        actions: [],
        conditions: [{ kind: ConditionKind.EventPropertyIs, key: RELATION_KEY, value: relType }],
      })
      wrote = true
    }
    return wrote ? 'written' : 'present'
  } catch {
    // The existing ACL telemetry channel, payload-free by construction (ADR-007 §3): it says WHAT
    // failed, never for whom.
    telemetry.untranslated({ conceptKind: 'protocol-event', shape: { eventType: 'fold-rules-unwritten' } })
    return 'failed'
  }
}
