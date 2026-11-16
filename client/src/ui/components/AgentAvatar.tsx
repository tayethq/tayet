import type { AgentColor, Channel, User } from '@tayet/client'
import type { Size } from '../primitives'
import { t } from '../i18n'

// AgentAvatar (ADR-086 Proposto dec. 2; manifests workspace.md §15.1 and account-access.md §11.1).
// The agent mark IS the avatar: the canvas glyph (a robot in stroke) in place of the monogram, in the
// agent's colour, with the blue indicator exclusive to agents where the presence dot would sit. No
// text badge beside the name. One piece for every surface of PLANO-AGENTES §0 F1 (the gate in
// test/ui/agent-mark-render-scan.test.tsx).
//
// Same idiom as the Avatar primitive (.ui-avatar box + a sibling in a relative wrapper), but NOT
// decorative: an agent's avatar is the identification, so the wrapper is role="img" with the
// catalogue's "Agente" as its accessible name (and title). The glyph and the indicator are
// aria-hidden. An agent never shows presence: there is no presence prop.
// `data-agent-avatar` / `data-agent-mark` are the gate's hooks; `data-agent-color` picks the token
// trio (--color-agent-<colour>-bg|border|fg) in styles.css. No photo: a photo would hide the mark.
// `perfil` is the profile dialog's avatar (view-profile manifest, 148): the same piece, bigger.
// `decorative`: inside a control that already names it (an option of the colour picker, whose name is
// the colour) — aria-hidden, no role.
export function AgentAvatar({
  color,
  size = 'cotidiano',
  decorative = false,
}: {
  color: AgentColor
  size?: Size | 'perfil'
  decorative?: boolean
}) {
  const label = t('agent.label')
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': label, title: label }
  return (
    <span className="ui-avatar-wrap agent-avatar" {...a11y} data-agent-avatar="" data-agent-color={color}>
      <span className="ui-avatar agent-avatar__box" data-size={size} aria-hidden="true">
        {/* Glyph verbatim from the canvas (account-access People/AgentDialog, workspace shell). */}
        <svg
          className="agent-avatar__glyph"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="10" height="8" rx="2" />
          <path d="M8 5V2.5" />
          <path d="M6 9h.01" />
          <path d="M10 9h.01" />
        </svg>
      </span>
      <span className="agent-avatar__mark" data-agent-mark="" aria-hidden="true" />
    </span>
  )
}

// The colour of a User when it is an agent; undefined for a person. The fallback mirrors the ACL's
// (an agent whose colour is not readable is 'areia').
export function agentColorOf(user: Pick<User, 'kind' | 'agentColor'> | undefined): AgentColor | undefined {
  return user?.kind === 'agent' ? (user.agentColor ?? 'areia') : undefined
}

// The DM's peer as an agent, from the channel (a DM carries no User — PLANO-AGENTES §0 F1).
export function peerAgentColorOf(channel: Pick<Channel, 'kind' | 'peerAgent'> | undefined): AgentColor | undefined {
  return channel?.kind === 'dm' ? channel.peerAgent?.color : undefined
}
