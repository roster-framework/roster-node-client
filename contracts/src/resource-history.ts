import {z} from 'zod';

const Id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const Version=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Title=z.string().min(1).max(200);
const Updated=z.iso.datetime({offset:true});
// Metadata intentionally cannot contain a body. Original selection is explicit.
export const ResourceDocumentMetadata=z.object({
 id:Id,unit_id:Id,collection:Id,source_kind:z.enum(['upload','file','mcp','external']),
 source_uri:z.string().max(2000),source_version:z.string().max(200).optional(),
 media_type:z.string().max(200).optional(),title:Title,version:Version,updated:Updated,
}).strict();
export const ResourceDocument=ResourceDocumentMetadata.extend({body:z.string().max(200000).optional()}).strict();
export const ResourceDocumentList=z.object({resources:z.array(ResourceDocumentMetadata)}).strict();
export const ResourceDocumentResponse=z.object({resource:ResourceDocument}).strict();
export const ResourceHistoryQuery=z.object({limit:z.number().int().min(1).max(100).default(20),after:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0)}).strict();
export const ResourceVersion=z.object({version:Version,title:Title,updated:Updated}).strict();
export const ResourceHistoryPage=z.object({resource_id:Id,items:z.array(ResourceVersion).max(100),next_after:Version.optional()}).strict();
export function validateResourceHistoryPage(value:unknown,id:string,input:Partial<ResourceHistoryQuerySpec>={}) {
 Id.parse(id);const query=ResourceHistoryQuery.parse(input),page=ResourceHistoryPage.parse(value);let last=query.after;
 if(page.resource_id!==id||page.items.length>query.limit)throw Error('Invalid resource history page');
 for(const item of page.items){if(item.version<=last)throw Error('Invalid resource history order');last=item.version;}
 if(page.next_after!==undefined&&(page.items.length!==query.limit||page.next_after!==last))throw Error('Invalid resource history continuation');
 return page;
}
export function validateResourceDocumentList(value:unknown) {
 const list=ResourceDocumentList.parse(value);
 if(new Set(list.resources.map(r=>r.id)).size!==list.resources.length)throw Error('Invalid resource document list');
 return list.resources;
}
export function validateResourceDocument(value:unknown,id:string,version:number) {
 Id.parse(id);Version.parse(version);const {resource}=ResourceDocumentResponse.parse(value);
 if(resource.id!==id||resource.version!==version)throw Error('Invalid selected resource');return resource;
}
export type ResourceDocumentMetadataSpec=z.infer<typeof ResourceDocumentMetadata>;
export type ResourceDocumentSpec=z.infer<typeof ResourceDocument>;
export type ResourceHistoryQuerySpec=z.infer<typeof ResourceHistoryQuery>;
export type ResourceHistoryPageSpec=z.infer<typeof ResourceHistoryPage>;
