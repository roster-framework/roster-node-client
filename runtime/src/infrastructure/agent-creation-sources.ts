import {AgentCreationDeclaration} from '@roster/contracts';
import type {AgentTemplate} from '../domain/agent-template.js';
import {snapshotAgentParameters} from '../domain/agent-parameters.js';
import {creationFingerprint,type CreationSourceProvider} from '../application/agent-creation.js';

export function authorCreationSources(templates:AgentTemplate[],credential:(reference:string)=>string|undefined):CreationSourceProvider {
  const owned=templates.map(template=>({...template,parameter_schema:snapshotAgentParameters(template.parameter_schema),credential_parameters:[...(template.credential_parameters??[])]}));
  return ()=>owned.map(template=>{
    if(typeof template.version!=='string'||!template.version.trim()||template.version.length>100)throw Error('Author template version required');
    const descriptor={kind:'template',id:template.id,name:template.name,description:template.description,parameter_schema:template.parameter_schema,credential_parameters:template.credential_parameters};
    const declaration=AgentCreationDeclaration.parse({...descriptor,revision:creationFingerprint({version:template.version,...descriptor})});
    return {declaration,build:(id,name,parameters)=>{
      const allowed=new Set(template.credential_parameters.map(key=>parameters[key]).filter((value):value is string=>typeof value==='string'&&!!value));
      return {agent:template.create({id,name,parameters,credentials:{get:reference=>allowed.has(reference)?credential(reference):undefined}})};
    }};
  });
}
