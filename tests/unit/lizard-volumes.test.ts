import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ids, mcpFixture } from '../helpers/outbound-mcp'
import { saveLizardConnection } from '../../server/utils/lizard-connection'
import { createLizardVolume, deleteUnusedLizardVolume, findLizardVolume, lizardVolumeName } from '../../server/utils/lizard-volumes'
let f: ReturnType<typeof mcpFixture>
const workspace='b5949476-1a4e-4141-bfc6-a72a7751fd95'
beforeEach(async()=>{f=mcpFixture();vi.stubGlobal('fetch',vi.fn(async()=>Response.json([{id:'project-a',name:'A'}])));await saveLizardConnection(f.env,await f.actor(),'secret-key','project-a')})
afterEach(()=>{vi.unstubAllGlobals();f.db.close()})
it('creates a project-scoped 5GB disk with a stable workspace name and region',async()=>{
 const name=lizardVolumeName(workspace),calls:{url:string;init?:RequestInit}[]=[]
 vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{calls.push({url,init});return Response.json({id:'disk-1',name})}))
 expect(await createLizardVolume(f.env,workspace,'us-east-1')).toEqual({id:'disk-1',name})
 expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({name,sizeGb:5,region:'us-east-1'})
})
it('reconciles by name and rejects mismatched disk ownership',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:'disk-2',name:'other'})))
 await expect(findLizardVolume(f.env,workspace)).rejects.toMatchObject({statusCode:503})
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(null,{status:404})))
 expect(await findLizardVolume(f.env,workspace)).toBeNull()
})
it('refuses to remove a disk attached to a VM or associated with another Node',async()=>{
 const name=lizardVolumeName(workspace)
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:'disk-1',name,attachedTo:'vm'})))
 await expect(deleteUnusedLizardVolume(f.env,workspace,null)).rejects.toMatchObject({statusCode:409})
 f.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,created_by,created_at) VALUES(?,?,?,?,?)').run('other-node','Lizard '+workspace,'token',f.db.prepare('SELECT owner_id AS id FROM server').get()!.id,new Date().toISOString())
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({id:'disk-1',name,attachedTo:null})))
 await expect(deleteUnusedLizardVolume(f.env,workspace,null)).rejects.toMatchObject({statusCode:409})
})
it('preserves a disk until every Task workspace has been explicitly released',async()=>{
 const name=lizardVolumeName(workspace),node='managed-node',now=new Date().toISOString()
 f.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,created_by,created_at) VALUES(?,?,?,?,?)').run(node,'Lizard '+workspace,'token',ids.owner,now)
 f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('board','QA',ids.owner)
 f.db.prepare("INSERT INTO tasks(id,board_id,title,assignee_id,created_by,status) VALUES(?,?,?,?,?,'ready')").run('task-qa1','board','QA',ids.agent,ids.owner)
 const {run}=await f.run(ids.owner,undefined,'task-qa1')
 f.db.prepare('INSERT INTO factory_workspaces(id,channel_id,task_id,agent_id,initiated_by,node_id,environment_json,origin_run_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('work','public-chat','task-qa1',ids.agent,ids.owner,node,'{}',run.id,'ready',now,now)
 const fetcher=vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='DELETE'?new Response(null,{status:204}):Response.json({id:'disk-1',name,attachedTo:null}))
 vi.stubGlobal('fetch',fetcher)
 await expect(deleteUnusedLizardVolume(f.env,workspace,node)).rejects.toMatchObject({statusCode:409})
 expect(fetcher).toHaveBeenCalledTimes(1)
 f.db.prepare("UPDATE factory_workspaces SET status='released' WHERE id='work'").run()
 expect(await deleteUnusedLizardVolume(f.env,workspace,node)).toEqual({deleted:true})
})
it('releases the workspaces of Done Tasks itself, so retained storage can be deleted without another Task',async()=>{
 const name=lizardVolumeName(workspace),node='managed-node',now=new Date().toISOString()
 f.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,created_by,created_at) VALUES(?,?,?,?,?)').run(node,'Lizard '+workspace,'token',ids.owner,now)
 f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('board','QA',ids.owner)
 f.db.prepare("INSERT INTO tasks(id,board_id,title,assignee_id,created_by,status) VALUES(?,?,?,?,?,'ready')").run('task-qa1','board','QA',ids.agent,ids.owner)
 const {run}=await f.run(ids.owner,undefined,'task-qa1')
 f.db.prepare('INSERT INTO factory_workspaces(id,channel_id,task_id,agent_id,initiated_by,node_id,environment_json,origin_run_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('work','public-chat','task-qa1',ids.agent,ids.owner,node,'{}',run.id,'ready',now,now)
 vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>init?.method==='DELETE'?new Response(null,{status:204}):Response.json({id:'disk-1',name,attachedTo:null})))
 f.db.prepare("UPDATE tasks SET status='done' WHERE id='task-qa1'").run()
 expect(await deleteUnusedLizardVolume(f.env,workspace,node)).toEqual({deleted:true})
 expect(f.db.prepare("SELECT status FROM factory_workspaces WHERE id='work'").get()).toEqual({status:'released'})
})
