import type { SocketSession } from './ticket'

type AuthenticatedSocket = {
  deserializeAttachment(): SocketSession | null
  close(code: number, reason: string): void
}

/** Hibernating sockets outlive membership changes; admission is not a read grant. */
export async function authorizedSockets<T extends AuthenticatedSocket>(
  sockets: T[],
  canReceive: (userId: string, session: SocketSession) => Promise<boolean>,
): Promise<T[]> {
  const checks = new Map<string, Promise<'allowed' | 'denied' | 'unknown'>>()
  const allowed = await Promise.all(sockets.map(async socket => {
    const session = socket.deserializeAttachment()
    const userId = session?.userId
    if (!userId || !session) return false
    const key = JSON.stringify([userId, session.sessionId || null])
    let check = checks.get(key)
    if (!check) {
      check = Promise.resolve().then(() => canReceive(userId, session)).then(ok => ok ? 'allowed' : 'denied', () => 'unknown')
      checks.set(key, check)
    }
    const verdict = await check
    if (verdict === 'allowed') return true
    // A check that could not run (a database error, say) says nothing about access: this send is
    // skipped and the socket stays, since the next fanout checks again. Only a denial closes it,
    // and the client treats that close as final.
    if (verdict === 'denied') {
      try { socket.close(4403, 'access_revoked') }
      catch { /* Already disconnected. Never send when authorization fails. */ }
    }
    return false
  }))
  return sockets.filter((_, index) => allowed[index])
}
