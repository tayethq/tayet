import { t } from '../i18n'

// The group conversation's block (ADR-094; manifest workspace.md §22.1 items 2 to 4, §22.2): where a DM
// has the person's avatar, a group has a box with the number of participants, counting the reader. Two
// uses (the list row and the header): local to these surfaces, not a primitive of the tier (ADR-036
// dec. 3). The Avatar's recipe — its background and monogram colour — with the number in mono; 28 in
// the list (the cotidiano avatar), 30 in the header (raw component constants, §22.2).
//
// With an agent among the participants (P6, §22.1 item 3) the block carries the agent's dot where the
// presence dot would sit (§22.5 item 1): 9, ring 2, `color-agent-mark`. Never presence. The block is
// the identification of the conversation's kind, so it is role="img" with the catalogue's name; the
// number and the dot are aria-hidden. Nothing about who is in it: no id, no name (P1).
export function GroupBlock({ count, agent, size }: { count: number; agent: boolean; size: 'list' | 'header' }) {
  return (
    <span className="group-block-wrap" role="img" aria-label={t('group.blockLabel', { n: count })} data-group-block="">
      <span className="group-block" data-size={size} aria-hidden="true">
        {count}
      </span>
      {agent && <span className="group-block__agent" data-group-agent="" aria-hidden="true" />}
    </span>
  )
}

// The block's number: the participants plus whoever reads (§22.1 item 2). A group with nobody else is 1.
export function groupCount(participants: readonly unknown[] | undefined): number {
  return (participants?.length ?? 0) + 1
}
