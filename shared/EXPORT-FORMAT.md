# Tayet data export format, version 1

A Tayet data export is a folder (delivered as a `.zip` file) holding a copy of a person's data in plain,
documented files. It is written by the Tayet app, in the person's own browser session: the person asks for
it from their account, and their device reads and packs the data. The folder is meant to be read by a person
with no special tool and by any program that follows this document.

The export is **plain text and is not encrypted**. It carries, in readable form, messages that are
end-to-end encrypted on the server. It has no password. Keeping the file safe is up to whoever downloaded it.

The export is a copy for reading and portability. It is not a backup and cannot be imported back.

## Files

```
README.txt
manifest.json
account.json
conversations/
  c1.json
  c2.json
  …
attachments/
  account/
    avatar.<ext>
  c1/
    m9-relatorio.pdf
  …
```

| Path | What it is |
|---|---|
| `README.txt` | A short text, in the person's language, saying what the export holds and what it leaves out. |
| `manifest.json` | The index: format and version, the people referenced, the list of conversations with their counts. |
| `account.json` | The person's profile, the accesses to the account and the agents the person operates. |
| `conversations/<id>.json` | One file per conversation the person is in, always present, even with no item. |
| `attachments/<conversation id>/<message id>-<name>` | A file the person sent, next to the message that carried it. |
| `attachments/account/avatar.<ext>` | The person's profile picture, when there is one. |

## Common rules

- All JSON files are UTF-8, indented with two spaces, end with one newline, and keep a fixed key order. The
  same data always produces the same bytes.
- Instants are ISO 8601 strings in UTC, with milliseconds (`2026-11-13T21:00:00.000Z`).
- Identifiers are **synthetic** and only mean something inside one export: `p<n>` for people, `c<n>` for
  conversations, `m<n>` for messages, numbered in the order the export met them. No server identifier,
  token or key is ever written.
- An optional field is left out when it has no value; it is never written as `null`.

## `manifest.json`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `format` | string | yes | Always `"tayet-export"`. |
| `formatVersion` | integer | yes | The format version, `1` for this document. |
| `scope` | string | yes | Whose data this is. `"person"`: the export of one person, made in the app. Other values may be added by other tools. |
| `createdAt` | instant | yes | When the export was made. |
| `subject` | person id | yes | The person the export is about. |
| `people` | array | yes | Every person referenced anywhere in the export, and only those. |
| `people[].id` | person id | yes | |
| `people[].name` | string | yes | The name shown in the product when the export was made. |
| `people[].kind` | string | yes | `"member"` (of the organization), `"guest"` or `"agent"`. |
| `conversations` | array | yes | Every conversation in the export, in export order. |
| `conversations[].id` | conversation id | yes | |
| `conversations[].file` | path | yes | The conversation's file, `conversations/<id>.json`. |
| `conversations[].name` | string | yes | The conversation's name as the person saw it. |
| `conversations[].kind` | string | yes | `"public"` or `"private"` (channels), `"dm"` (direct conversation), `"group"` (group conversation). |
| `conversations[].joinedAt` | instant | no | When the person first joined the conversation, when known. |
| `conversations[].messages` | integer | yes | Items of type `message` and `approvalResponse`. |
| `conversations[].deleted` | integer | yes | Items of type `deleted`. |
| `conversations[].attachments` | integer | yes | Attachments included as files. |
| `conversations[].gaps` | integer | yes | Items of type `unreadable` plus attachments marked `missing`. |
| `totals` | object | yes | The sums over all conversations: `conversations` (how many), `messages`, `deleted`, `attachments`, `gaps`. |

## `account.json`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `formatVersion` | integer | yes | Same as in the manifest. |
| `profile.fullName` | string | yes | The person's full name. |
| `profile.nickname` | string | no | What the person likes to be called. |
| `profile.pronouns` | string | no | |
| `profile.note` | string | no | The short note on the profile. |
| `profile.jobTitle` | string | no | |
| `profile.workEmail` | string | no | |
| `profile.avatar` | path | no | The profile picture, `attachments/account/avatar.<ext>`. Left out when the person has none or the picture could not be obtained. |
| `accesses` | array | yes | The accesses to the account (browsers and devices signed in). |
| `accesses[].name` | string | yes | The access's name as the product shows it. |
| `accesses[].lastSeenAt` | instant | no | When it was last active, when known. |
| `accesses[].current` | boolean | yes | `true` for the access that made the export. |
| `agents` | array | yes | The agents the person operates. |
| `agents[].person` | person id | yes | The agent, listed in the manifest's `people`. |

## `conversations/<id>.json`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `formatVersion` | integer | yes | Same as in the manifest. |
| `conversation` | conversation id | yes | The conversation this file belongs to. |
| `items` | array | yes | The person's items in this conversation, by ascending `sentAt`; items sent at the same instant keep the export order. Empty when the person sent nothing there. |

Every item has `type`, `id` (a message id) and `sentAt` (when it was sent). The types:

### `message`

A message the person sent, in its final version.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `editedAt` | instant | no | When it was last edited. |
| `text` | string | yes | The plain text. Empty for a message that is only an attachment. |
| `rich` | array | no | The formatted text, when the message has formatting (see "Rich text"). |
| `mentions` | array of person ids | no | The people mentioned. |
| `attachment` | object | no | The file the message carried (see below). |
| `inThread` | boolean | yes | Whether the message is in a thread. |
| `threadRoot` | message id | no | The thread's first message, only when that message is the person's and is in this file. |
| `isReply` | boolean | yes | Whether the message replies to another one. |
| `replyTo` | message id | no | The message replied to, only when it is the person's and is in this file. |

When a thread was started, or a replied-to message was written, by someone else, only `inThread` or
`isReply` is `true`: the other person's message is not in the export, so there is nothing to point at.

`attachment`:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `file` | path | no | Where the file is in the folder. Absent when the file is missing. |
| `name` | string | yes | The file's original name. |
| `mimetype` | string | yes | The file's media type. |
| `size` | integer | no | The size in bytes, when known. |
| `missing` | `true` | no | The file could not be obtained when the export was made. Counts as a gap. |

### `deleted`

A message the person deleted. Only `type`, `id` and `sentAt`: no content and no attachment. It shows that
there was a message there. An answer to an approval request that the person deleted appears the same way:
once deleted, the device cannot tell it from a message.

### `unreadable`

A message the device that made the export could not read. Only `type`, `id` and `sentAt`. Counts as a gap.

### `unsupported`

A message of a kind the product does not show. Only `type`, `id` and `sentAt`. Not a gap.

### `approvalResponse`

The person's answer to an approval request an agent made.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `option` | string | yes | The option the person chose, as it was labelled. |
| `requestedBy` | person id | yes | The agent that asked. |

The text of the request is not included: it is a message from someone else.

### Rich text

`rich` is a list of blocks. Each node has a `t` field:

- Blocks: `p` (`children`: inline nodes), `ul` and `ol` (`items`: a list of items, each a list of blocks),
  `quote` (`children`: blocks), `codeblock` (`text`, optional `lang`).
- Inline nodes: `text` (`text`), `code` (`text`), `strong`, `em` and `strike` (`children`: inline nodes),
  `link` (`href`, `children`: inline nodes).

`text` always holds the same message as plain text, so a reader may ignore `rich`.

## Attachment paths

An attachment is written at `attachments/<conversation id>/<message id>-<name>`, where `<name>` is the
original name made safe:

1. normalized to Unicode NFC;
2. path separators (`/`, `\`), control characters and the characters Windows reserves (`< > : " | ? *`)
   removed;
3. leading and trailing spaces and dots removed;
4. cut to 100 characters, keeping the extension;
5. if nothing is left, `file`, with the extension of the media type when it is a known one.

The original name stays in the message's `attachment.name`. The profile picture is written at
`attachments/account/avatar.<ext>`, with the extension of its media type (no extension when the type is
not a known one).

## Gaps

A gap is something the export should hold and does not: a message the device could not read (an
`unreadable` item) or an attachment that could not be obtained (`missing: true`). Gaps are never dropped
silently: each one is an item or a mark in its conversation file and is counted in the manifest, per
conversation and in the totals.

## What a person's export does not include

- Messages from other people, including the ones that mention the person.
- Messages written by the agents the person operates.
- Reactions. They are left out of this version.
- Conversations the person has left.
- The network address of each access to the account.
- The server's audit log, which the app cannot reach.

## Versions

`formatVersion` is `1`. A new optional field does not change the version; a change that would break an
existing reader increments it. A reader must ignore fields it does not know, and should refuse a
`formatVersion` higher than the one it knows.

## Example

A complete example: the files below are one export, verbatim.

```
README.txt
manifest.json
account.json
conversations/
  c1.json
  c2.json
  c3.json
  c4.json
attachments/
  account/
    avatar.webp
  c1/
    m9-relatorio.pdf
  c3/
    m16-Plano Q4final.xlsx
```

The files under `attachments/` are the files themselves and are not shown. The README text below is a placeholder: the app writes its own.

### `README.txt`

```text
Esta pasta é uma cópia dos seus dados.

Ela traz o que você enviou: mensagens, arquivos e respostas a pedidos de aprovação.
```

### `manifest.json`

```json
{
  "format": "tayet-export",
  "formatVersion": 1,
  "scope": "person",
  "createdAt": "2026-11-13T21:00:00.000Z",
  "subject": "p1",
  "people": [
    {
      "id": "p1",
      "name": "Marina Alves",
      "kind": "member"
    },
    {
      "id": "p2",
      "name": "Atlas",
      "kind": "agent"
    },
    {
      "id": "p3",
      "name": "Bruno Costa",
      "kind": "member"
    },
    {
      "id": "p4",
      "name": "Relatórios",
      "kind": "agent"
    },
    {
      "id": "p5",
      "name": "Lucas Prado",
      "kind": "guest"
    }
  ],
  "conversations": [
    {
      "id": "c1",
      "file": "conversations/c1.json",
      "name": "diretoria",
      "kind": "private",
      "joinedAt": "2026-10-02T12:00:00.000Z",
      "messages": 11,
      "deleted": 1,
      "attachments": 1,
      "gaps": 2
    },
    {
      "id": "c2",
      "file": "conversations/c2.json",
      "name": "Bruno Costa",
      "kind": "dm",
      "joinedAt": "2026-10-05T09:00:00.000Z",
      "messages": 1,
      "deleted": 0,
      "attachments": 0,
      "gaps": 0
    },
    {
      "id": "c3",
      "file": "conversations/c3.json",
      "name": "Bruno Costa, Lucas Prado",
      "kind": "group",
      "messages": 1,
      "deleted": 0,
      "attachments": 1,
      "gaps": 0
    },
    {
      "id": "c4",
      "file": "conversations/c4.json",
      "name": "geral",
      "kind": "public",
      "joinedAt": "2026-10-01T08:00:00.000Z",
      "messages": 0,
      "deleted": 0,
      "attachments": 0,
      "gaps": 0
    }
  ],
  "totals": {
    "conversations": 4,
    "messages": 13,
    "deleted": 1,
    "attachments": 2,
    "gaps": 2
  }
}
```

### `account.json`

```json
{
  "formatVersion": 1,
  "profile": {
    "fullName": "Marina Alves",
    "nickname": "Mari",
    "pronouns": "ela",
    "note": "De férias até segunda.",
    "jobTitle": "Produto",
    "workEmail": "marina@vereda.example",
    "avatar": "attachments/account/avatar.webp"
  },
  "accesses": [
    {
      "name": "Chrome no macOS",
      "lastSeenAt": "2026-11-13T20:00:00.000Z",
      "current": true
    },
    {
      "name": "Safari no iPhone",
      "current": false
    }
  ],
  "agents": [
    {
      "person": "p2"
    }
  ]
}
```

### `conversations/c1.json`

```json
{
  "formatVersion": 1,
  "conversation": "c1",
  "items": [
    {
      "type": "message",
      "id": "m1",
      "sentAt": "2026-11-10T13:00:00.000Z",
      "text": "Bom dia, pessoal.",
      "inThread": false,
      "isReply": false
    },
    {
      "type": "message",
      "id": "m2",
      "sentAt": "2026-11-10T13:05:00.000Z",
      "editedAt": "2026-11-10T13:07:30.000Z",
      "text": "Pauta de amanhã: orçamento e contratações.",
      "rich": [
        {
          "t": "p",
          "children": [
            {
              "t": "text",
              "text": "Pauta de "
            },
            {
              "t": "strong",
              "children": [
                {
                  "t": "text",
                  "text": "amanhã"
                }
              ]
            },
            {
              "t": "text",
              "text": ":"
            }
          ]
        },
        {
          "t": "ul",
          "items": [
            [
              {
                "t": "p",
                "children": [
                  {
                    "t": "text",
                    "text": "orçamento"
                  }
                ]
              }
            ],
            [
              {
                "t": "p",
                "children": [
                  {
                    "t": "text",
                    "text": "contratações"
                  }
                ]
              }
            ]
          ]
        }
      ],
      "inThread": false,
      "isReply": false
    },
    {
      "type": "message",
      "id": "m3",
      "sentAt": "2026-11-10T14:00:00.000Z",
      "text": "Atlas e Bruno, podem revisar o resumo?",
      "mentions": [
        "p2",
        "p3"
      ],
      "inThread": false,
      "isReply": false
    },
    {
      "type": "message",
      "id": "m4",
      "sentAt": "2026-11-10T15:00:00.000Z",
      "text": "Abro uma thread para o orçamento.",
      "inThread": false,
      "isReply": false
    },
    {
      "type": "message",
      "id": "m5",
      "sentAt": "2026-11-10T15:10:00.000Z",
      "text": "Primeiro número: dentro do previsto.",
      "inThread": true,
      "threadRoot": "m4",
      "isReply": false
    },
    {
      "type": "message",
      "id": "m6",
      "sentAt": "2026-11-10T15:20:00.000Z",
      "text": "Concordo com a proposta.",
      "inThread": true,
      "isReply": false
    },
    {
      "type": "message",
      "id": "m7",
      "sentAt": "2026-11-10T16:00:00.000Z",
      "text": "Pode ser na quinta.",
      "inThread": false,
      "isReply": true
    },
    {
      "type": "message",
      "id": "m8",
      "sentAt": "2026-11-10T16:05:00.000Z",
      "text": "Corrigindo: na sexta.",
      "inThread": false,
      "isReply": true,
      "replyTo": "m7"
    },
    {
      "type": "message",
      "id": "m9",
      "sentAt": "2026-11-11T10:00:00.000Z",
      "text": "",
      "attachment": {
        "file": "attachments/c1/m9-relatorio.pdf",
        "name": "relatorio.pdf",
        "mimetype": "application/pdf",
        "size": 48213
      },
      "inThread": false,
      "isReply": false
    },
    {
      "type": "message",
      "id": "m10",
      "sentAt": "2026-11-11T10:01:00.000Z",
      "text": "",
      "attachment": {
        "name": "foto.png",
        "mimetype": "image/png",
        "missing": true
      },
      "inThread": false,
      "isReply": false
    },
    {
      "type": "deleted",
      "id": "m11",
      "sentAt": "2026-11-11T11:00:00.000Z"
    },
    {
      "type": "unreadable",
      "id": "m12",
      "sentAt": "2026-11-11T11:30:00.000Z"
    },
    {
      "type": "unsupported",
      "id": "m13",
      "sentAt": "2026-11-11T11:45:00.000Z"
    },
    {
      "type": "approvalResponse",
      "id": "m14",
      "sentAt": "2026-11-12T09:00:00.000Z",
      "option": "Aprovar",
      "requestedBy": "p4"
    }
  ]
}
```

### `conversations/c2.json`

```json
{
  "formatVersion": 1,
  "conversation": "c2",
  "items": [
    {
      "type": "message",
      "id": "m15",
      "sentAt": "2026-11-12T18:00:00.000Z",
      "text": "Obrigada pela ajuda ontem.",
      "inThread": false,
      "isReply": false
    }
  ]
}
```

### `conversations/c3.json`

```json
{
  "formatVersion": 1,
  "conversation": "c3",
  "items": [
    {
      "type": "message",
      "id": "m16",
      "sentAt": "2026-11-12T19:00:00.000Z",
      "text": "Segue a planilha, Lucas.",
      "mentions": [
        "p5"
      ],
      "attachment": {
        "file": "attachments/c3/m16-Plano Q4final.xlsx",
        "name": "Plano Q4/final.xlsx",
        "mimetype": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "size": 9120
      },
      "inThread": false,
      "isReply": false
    }
  ]
}
```

### `conversations/c4.json`

```json
{
  "formatVersion": 1,
  "conversation": "c4",
  "items": []
}
```
