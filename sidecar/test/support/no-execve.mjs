// `node --import` hook for the relaunch fallback (PLANO-AGENTES §0.3.14 item 4): removes process.execve,
// as on Windows or a Node 22 older than 22.15, so the sidecar relaunches through a child process.
process.execve = undefined
