// The method table of the Slack layer (PLANO-AGENTES §0.3.12 item 7): one module per family of methods.
import { AUTH_METHODS } from './auth'
import { CHAT_METHODS } from './chat'
import { CONNECTION_METHODS } from './connections'
import { CONVERSATION_METHODS } from './conversations'
import { FILE_METHODS } from './files'
import { REACTION_METHODS } from './reactions'
import { USER_METHODS } from './users'
import type { SlackMethods } from './router'

export const SLACK_METHODS: readonly SlackMethods[] = [AUTH_METHODS, CONVERSATION_METHODS, CHAT_METHODS, REACTION_METHODS, FILE_METHODS, USER_METHODS, CONNECTION_METHODS]
