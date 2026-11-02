import { getServerId } from '../../../shared/server-id'
import { z } from 'zod'
import type { DatabasePageDTO } from '../../../shared/types'
import { Permission } from '../../../shared/permissions'
import { cf, fail } from '../../utils/cf'
import { loadDatabasePage, validCalendarRange } from '../../utils/database-views'
import { requireMember } from '../../utils/guards'

const querySchema = z.object({
  view: z.string().min(1).optional(),
  search: z.string().max(500).default(''),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
}).refine(query => Boolean(query.dateFrom) === Boolean(query.dateTo), {
  message: 'Calendar range requires both dates',
}).refine(query => !query.dateFrom || !query.dateTo || validCalendarRange(query.dateFrom, query.dateTo), {
  message: 'Calendar range must be ordered and cannot exceed 62 days',
})

export default defineEventHandler(async (event): Promise<DatabasePageDTO> => {
  const actor = await requireMember(event, (await getServerId(cf(event).env.DB)), Permission.readData)
  const parsed = querySchema.safeParse(getQuery(event))
  if (!parsed.success) fail(400, 'bad_request', parsed.error.issues[0]?.message ?? 'Invalid database query')
  const query = parsed.data
  return loadDatabasePage(cf(event).env, getRouterParam(event, 'id')!, {
    viewId: query.view,
    search: query.search,
    page: query.page,
    pageSize: query.pageSize,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    authorization: actor.authorization,
  })
})
