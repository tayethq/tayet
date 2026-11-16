// Entry for the dist smoke (§0.3.5 adj. 2): the S-b1 core imports nothing from @tayet/shared yet, so
// dist/cli.js does not carry the translator. This probe is bundled with the exact options of
// build.mjs and run with node, so the Node-resolvability of the shared's SDK imports (crypto-api
// included) is gated now, not when the first importer lands.
import { buildTextContent, eventToMessage, stableMessageId } from '@tayet/shared/internal'
import * as sdk from 'matrix-js-sdk'

process.stdout.write(
  JSON.stringify({
    evt: 'shared-probe',
    eventToMessage: typeof eventToMessage,
    stableMessageId: typeof stableMessageId,
    content: buildTextContent('oi'),
    sdk: typeof sdk.createClient,
  }) + '\n',
)
