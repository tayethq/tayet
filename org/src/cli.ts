// The org service's operator command, run inside its container by `deploy.sh promote-admin EMAIL`:
//   node --experimental-strip-types src/cli.ts promote-admin <email>
// The promotion rules of PUT /v1/people/:userId/admin, by the same function, without a caller to
// check. No lock: promoting never leaves the organization without an admin. Reads the same ORG_* env
// as the server. Prints the username and whether it changed; a refusal is one line on stderr and a
// non-zero exit. Never prints a token or a secret.

import { pathToFileURL } from 'node:url'
import { adminLock, createAdmins, type Admins, type PromoteRefusal } from './admins.ts'
import { errorReason } from './audit.ts'
import { orgBackendFromEnv } from './server.ts'

export const CLI_ACTOR = 'deploy.sh'

const REFUSALS: Record<PromoteRefusal, string> = {
  not_found: 'no account for this email',
  not_member: 'not a member',
  deactivated: 'deactivated or locked',
  agent: 'agent',
  reserved: 'reserved account',
}

const USAGE = 'usage: cli.ts promote-admin <email>'

export async function runCli(
  argv: string[],
  deps: { admins: () => Admins; out: (line: string) => void; err: (line: string) => void },
): Promise<number> {
  const [command, email, ...rest] = argv
  if (command !== 'promote-admin' || email === undefined || rest.length > 0 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    deps.err(USAGE)
    return 2
  }
  try {
    // The email is matched as invites store it: lowercase.
    const outcome = await deps.admins().promoteByEmail(email.toLowerCase(), CLI_ACTOR)
    if (!outcome.ok) {
      deps.err(`promote-admin: ${REFUSALS[outcome.refusal]}`)
      return 1
    }
    deps.out(`${outcome.username}: ${outcome.changed ? 'promoted' : 'already an admin'}`)
    return 0
  } catch (err) {
    deps.err(`promote-admin: failed (${errorReason(err)})`)
    return 1
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const code = await runCli(process.argv.slice(2), {
    admins: () => {
      const { admin, audit, custodyUsername, org } = orgBackendFromEnv()
      return createAdmins({ masAdmin: admin, ...org, audit, serialize: adminLock(), custodyUsername })
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
  process.exit(code)
}
