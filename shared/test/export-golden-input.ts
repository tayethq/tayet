// Fixed input of the export golden example (format v1). Keys use the protocol-identifier shapes on
// purpose (the same forms leak-scan.test.ts uses): the tests prove none of them reaches the output.
// User content is neutral prose, so the full leak-scan pattern set applies to every output file.

import {
  createExportBuilder,
  type ExportFile,
  type ExportItemInput,
  type ExportPersonInput,
  type ExportStartInput,
} from '../src'

const at = (iso: string): number => Date.parse(iso)

// `$` + 43 base64url characters: the event-id shape (ADR-089 dec. 2).
const ev = (n: number): string => '$' + String(n).padStart(43, 'Q')

export const MARINA: ExportPersonInput = { key: '@u-abcdefghij23:tayet.local', name: 'Marina Alves', kind: 'member' }
export const ATLAS: ExportPersonInput = { key: '@a-abcdefghij23:tayet.local', name: 'Atlas', kind: 'agent' }
export const RELATORIOS: ExportPersonInput = { key: '@a-bbbbbbbbbbbb:tayet.local', name: 'Relatórios', kind: 'agent' }
export const BRUNO: ExportPersonInput = { key: '@bruno:tayet.local', name: 'Bruno Costa', kind: 'member' }
export const LUCAS: ExportPersonInput = { key: '@lucas:parceiro.example', name: 'Lucas Prado', kind: 'guest' }

export const README_TEXT = [
  'Esta pasta é uma cópia dos seus dados.',
  '',
  'Ela traz o que você enviou: mensagens, arquivos e respostas a pedidos de aprovação.',
].join('\n')

export interface GoldenConversation {
  input: { key: string; name: string; kind: 'public' | 'private' | 'dm' | 'group'; joinedAt?: number }
  items: ExportItemInput[]
}

export interface GoldenInput {
  start: ExportStartInput
  conversations: GoldenConversation[]
}

export const COMPLETE: GoldenInput = {
  start: {
    createdAt: at('2026-11-13T21:00:00.000Z'),
    subject: MARINA,
    profile: {
      fullName: 'Marina Alves',
      nickname: 'Mari',
      pronouns: 'ela',
      note: 'De férias até segunda.',
      jobTitle: 'Produto',
      workEmail: 'marina@vereda.example',
      avatar: { mimetype: 'image/webp' },
    },
    accesses: [
      { name: 'Chrome no macOS', lastSeenAt: at('2026-11-13T20:00:00.000Z'), current: true },
      { name: 'Safari no iPhone', current: false },
    ],
    agents: [ATLAS],
  },
  conversations: [
    {
      input: { key: '!diretoria:tayet.local', name: 'diretoria', kind: 'private', joinedAt: at('2026-10-02T12:00:00.000Z') },
      items: [
        { type: 'message', key: ev(1), sentAt: at('2026-11-10T13:00:00.000Z'), text: 'Bom dia, pessoal.' },
        {
          type: 'message',
          key: ev(2),
          sentAt: at('2026-11-10T13:05:00.000Z'),
          editedAt: at('2026-11-10T13:07:30.000Z'),
          text: 'Pauta de amanhã: orçamento e contratações.',
          rich: [
            {
              t: 'p',
              children: [
                { t: 'text', text: 'Pauta de ' },
                { t: 'strong', children: [{ t: 'text', text: 'amanhã' }] },
                { t: 'text', text: ':' },
              ],
            },
            { t: 'ul', items: [[{ t: 'p', children: [{ t: 'text', text: 'orçamento' }] }], [{ t: 'p', children: [{ t: 'text', text: 'contratações' }] }]] },
          ],
        },
        {
          type: 'message',
          key: ev(3),
          sentAt: at('2026-11-10T14:00:00.000Z'),
          text: 'Atlas e Bruno, podem revisar o resumo?',
          mentions: [ATLAS, BRUNO],
        },
        { type: 'message', key: ev(4), sentAt: at('2026-11-10T15:00:00.000Z'), text: 'Abro uma thread para o orçamento.' },
        {
          type: 'message',
          key: ev(5),
          sentAt: at('2026-11-10T15:10:00.000Z'),
          text: 'Primeiro número: dentro do previsto.',
          threadRoot: ev(4),
        },
        {
          type: 'message',
          key: ev(6),
          sentAt: at('2026-11-10T15:20:00.000Z'),
          text: 'Concordo com a proposta.',
          threadRoot: ev(900),
        },
        { type: 'message', key: ev(7), sentAt: at('2026-11-10T16:00:00.000Z'), text: 'Pode ser na quinta.', replyTo: ev(901) },
        { type: 'message', key: ev(8), sentAt: at('2026-11-10T16:05:00.000Z'), text: 'Corrigindo: na sexta.', replyTo: ev(7) },
        {
          type: 'message',
          key: ev(9),
          sentAt: at('2026-11-11T10:00:00.000Z'),
          text: '',
          attachment: { name: 'relatorio.pdf', mimetype: 'application/pdf', size: 48213, available: true },
        },
        {
          type: 'message',
          key: ev(10),
          sentAt: at('2026-11-11T10:01:00.000Z'),
          text: '',
          attachment: { name: 'foto.png', mimetype: 'image/png', available: false },
        },
        { type: 'deleted', key: ev(11), sentAt: at('2026-11-11T11:00:00.000Z') },
        { type: 'unreadable', key: ev(12), sentAt: at('2026-11-11T11:30:00.000Z') },
        { type: 'unsupported', key: ev(13), sentAt: at('2026-11-11T11:45:00.000Z') },
        {
          type: 'approvalResponse',
          key: ev(14),
          sentAt: at('2026-11-12T09:00:00.000Z'),
          option: 'Aprovar',
          requestedBy: RELATORIOS,
        },
      ],
    },
    {
      input: { key: '!dm-bruno:tayet.local', name: 'Bruno Costa', kind: 'dm', joinedAt: at('2026-10-05T09:00:00.000Z') },
      items: [{ type: 'message', key: ev(20), sentAt: at('2026-11-12T18:00:00.000Z'), text: 'Obrigada pela ajuda ontem.' }],
    },
    {
      input: { key: '!grupo:tayet.local', name: 'Bruno Costa, Lucas Prado', kind: 'group' },
      items: [
        {
          type: 'message',
          key: ev(30),
          sentAt: at('2026-11-12T19:00:00.000Z'),
          text: 'Segue a planilha, Lucas.',
          mentions: [LUCAS],
          attachment: { name: 'Plano Q4/final.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 9120, available: true },
        },
      ],
    },
    {
      input: { key: '!geral:tayet.local', name: 'geral', kind: 'public', joinedAt: at('2026-10-01T08:00:00.000Z') },
      items: [],
    },
    {
      input: { key: '!compras:tayet.local', name: 'compras', kind: 'private', joinedAt: at('2026-10-03T10:00:00.000Z') },
      items: [
        {
          type: 'formSubmission',
          key: ev(40),
          sentAt: at('2026-11-12T09:30:00.000Z'),
          title: 'Pedido de compra',
          requestedBy: RELATORIOS,
          fields: [
            { label: 'Fornecedor', value: 'Porto Print' },
            { label: 'Centro de custo', value: 'cc-210', option: 'Marketing' },
            { label: 'Itens', value: ['a4', 'toner'], option: ['Papel A4', 'Toner'] },
          ],
        },
      ],
    },
  ],
}

export const MINIMAL: GoldenInput = {
  start: {
    createdAt: at('2026-11-13T21:30:00.000Z'),
    subject: { key: '@u-zzzzzzzzzz23:tayet.local', name: 'Lia Souza', kind: 'guest' },
    profile: { fullName: 'Lia Souza' },
    accesses: [{ name: 'Firefox no Linux', lastSeenAt: at('2026-11-13T21:29:00.000Z'), current: true }],
    agents: [],
  },
  conversations: [
    { input: { key: '!convidados:tayet.local', name: 'convidados', kind: 'private' }, items: [] },
  ],
}

/** Every key of an input: the strings that must never appear in the output. */
export function keysOf(input: GoldenInput): string[] {
  const keys = new Set<string>([input.start.subject.key, ...input.start.agents.map((a) => a.key)])
  for (const c of input.conversations) {
    keys.add(c.input.key)
    for (const item of c.items) {
      keys.add(item.key)
      if (item.type === 'message') {
        for (const m of item.mentions ?? []) keys.add(m.key)
        if (item.threadRoot) keys.add(item.threadRoot)
        if (item.replyTo) keys.add(item.replyTo)
      }
      if (item.type === 'approvalResponse' || item.type === 'formSubmission') keys.add(item.requestedBy.key)
    }
  }
  return [...keys]
}

export interface GoldenOutput {
  files: ExportFile[]
  /** Paths the builder handed back for bytes the caller writes (profile picture, attachments). */
  attachmentPaths: string[]
}

/** Runs the builder over an input, the way a caller would: one conversation at a time. */
export function runExport(input: GoldenInput, readme = README_TEXT): GoldenOutput {
  const builder = createExportBuilder(input.start)
  const files: ExportFile[] = []
  const attachmentPaths: string[] = []
  if (builder.avatarPath) attachmentPaths.push(builder.avatarPath)
  for (const c of input.conversations) {
    const writer = builder.openConversation(c.input)
    for (const item of c.items) {
      const path = writer.add(item)
      if (path) attachmentPaths.push(path)
    }
    files.push(writer.close())
  }
  return { files: [...builder.finish(readme), ...files], attachmentPaths }
}
