import { getServerId } from '../../../shared/server-id'
import { authorizeResource, resourceAllowed } from '../../../shared/authorization'
import { Permission } from '../../../shared/permissions'
import type { DatabaseItemDTO, LinkedRecordDTO } from '../../../shared/types'
import { cf, fail } from '../../utils/cf'
import { loadDatabaseItem, loadItemLinks, loadLinkedRecords } from '../../utils/database-data'
import { requireMember } from '../../utils/guards'

/** One record with the titles its relations point at, for opening it on its own. */
export default defineEventHandler(async (event): Promise<{ item: DatabaseItemDTO; linked: Record<string, LinkedRecordDTO> }> => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.readData)
  const id = getRouterParam(event, 'id')!
  const item = await loadDatabaseItem(env, id)
  if (!item) fail(404, 'not_found', 'Database item not found')
  authorizeResource(actor.authorization, 'databases', item.databaseId)
  return { item, linked: await loadLinkedRecords(env, await loadItemLinks(env, [id]), databaseId => resourceAllowed(actor.authorization, 'databases', databaseId)) }
})
